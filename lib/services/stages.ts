/**
 * Pipeline stages — read/write helpers for the Service Catalog editor.
 *
 * `pipeline_stages` rows define the lifecycle a Service Delivery moves through
 * for a given service_type (e.g. Company Formation → Payment Confirmed →
 * Wizard Submitted → Filed with State → ... → EIN Received). Before this helper, the only way
 * to manage these rows was raw SQL migrations.
 *
 * The Service Catalog Add/Edit page uses these to let Antonio define stages
 * inline when authoring a new service, instead of needing an engineer.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"
import {
  type StageAction,
  SECOND_INSTALLMENT_TARGET_ACTION,
  stageHasAction,
} from "@/lib/services/stage-actions"

export { SECOND_INSTALLMENT_TARGET_ACTION, stageHasAction } from "@/lib/services/stage-actions"
export type { StageAction } from "@/lib/services/stage-actions"

export interface StageRow {
  /**
   * Row identity, present for a stage that already exists and absent for one
   * the admin just added. This ONE field is why the editor can rename, reorder
   * and delete stages safely: without it the write path could only match old
   * row to new row by NAME, which cannot tell a rename from a delete-plus-add.
   * See the note on `replaceStagesForService`.
   */
  id?: string
  stage_order: number
  stage_name: string
  stage_description?: string | null
  sla_days?: number | null
  auto_advance?: boolean | null
  notify_client_email?: boolean
  client_description?: string | null
  /**
   * Ordered list of per-stage action markers (jsonb array, mirrors auto_tasks).
   * Each entry is an object with a `type`. E.g. the 2nd-installment advance
   * target is marked with `{ type: "second_installment_target" }`.
   */
  auto_actions?: StageAction[] | null
}

export async function getStagesForService(serviceType: string): Promise<StageRow[]> {
  const { data, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select(
      "id, stage_order, stage_name, stage_description, sla_days, auto_advance, notify_client_email, client_description, auto_actions",
    )
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (error) throw new Error(`getStagesForService(${serviceType}): ${error.message}`)
  return (data ?? []) as StageRow[]
}

/** The rule for advancing a service delivery when the 2nd installment is paid. */
export interface SecondInstallmentAdvanceRule {
  target_stage: string
  source_stages: string[]
}

/**
 * Resolve, from `pipeline_stages` DATA (never hardcoded stage names), the rule
 * for advancing a service delivery to its wizard stage when the 2nd installment
 * is paid:
 *   - target  = the stage whose `auto_actions` array contains
 *               `{ type: "second_installment_target" }`
 *   - sources = every stage at `stage_order >= 1` (bundle entry onward,
 *               EXCLUDING the negative/zero standalone-intake stages) and below
 *               the target's order.
 *
 * This survives renames/reorders done in /config: the rule follows stage_order
 * + one data marker, not literal names.
 *
 * Returns null when no stage is flagged (rule not configured) so the caller can
 * fail safe + visible rather than guessing a stage name.
 */
export async function resolveSecondInstallmentAdvance(
  serviceType: string,
): Promise<SecondInstallmentAdvanceRule | null> {
  const { data, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_order, auto_actions")
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (error) throw new Error(`resolveSecondInstallmentAdvance(${serviceType}): ${error.message}`)

  const rows = (data ?? []) as Array<{ stage_name: string; stage_order: number; auto_actions: unknown }>
  const target = rows.find(r => stageHasAction(r.auto_actions, SECOND_INSTALLMENT_TARGET_ACTION))
  if (!target) return null

  const source_stages = rows
    .filter(r => r.stage_order >= 1 && r.stage_order < target.stage_order)
    .map(r => r.stage_name)

  return { target_stage: target.stage_name, source_stages }
}

/**
 * Stage orders are UNIQUE per service_type (`pipeline_stages_service_type_stage_order_key`,
 * verified on production). Reordering therefore cannot be done by assigning final
 * positions one row at a time — an intermediate state collides. Every row is first
 * parked at an order far outside the real range (which runs -10..90 in production;
 * negative orders are legitimately used for standalone-intake stages), then given
 * its final position.
 */
const PARK_OFFSET = 100000

/** Validation that must happen BEFORE anything is written. */
export function validateStageDraft(stages: StageRow[]): string | null {
  const seen = new Set<string>()
  for (let idx = 0; idx < stages.length; idx++) {
    const name = (stages[idx].stage_name ?? "").trim()
    if (!name) {
      return `Stage ${idx + 1} has no name. Every stage needs a name before you can save.`
    }
    if (seen.has(name.toLowerCase())) {
      return `Two stages are both called "${name}". Stage names must be unique within a service.`
    }
    seen.add(name.toLowerCase())
  }
  return null
}

/**
 * Reconcile a service's stages against what the editor submitted.
 *
 * WHY THIS IS NOT delete-then-insert ANY MORE (2026-07-22). It used to delete
 * every row for the service_type and re-insert only the nine columns the editor
 * authors. The row has twenty-three. Everything else — the entire staff
 * workspace descriptor (its components, buttons and advance targets), the
 * client-facing labels the portal renders, the board/portal display settings —
 * was silently destroyed on every Save. One Save on the ITIN service, even just
 * changing an SLA day count, would have erased all eight ITIN workspaces.
 *
 * A first attempt kept the delete and tried to read those columns back
 * beforehand and re-attach them. Council review rejected it, correctly: matching
 * an old row to a new one by NAME cannot distinguish a rename from a delete, so
 * it had to refuse renames outright; a failed insert left the table empty, and
 * the admin's natural "Save failed, try again" then wiped everything with the
 * guard asleep; and renaming the pipeline itself bypassed the whole thing.
 *
 * The actual defect was upstream: `getStagesForService` did not select the row
 * id, so identity was thrown away at LOAD time and the write path had nothing
 * but names to match on. With the id carried through, rows are UPDATED IN
 * PLACE. Columns the editor does not author are never named in any statement,
 * so they cannot be lost — not by oversight, not by a future column nobody
 * remembers to protect. There is nothing to "preserve" because nothing is
 * destroyed.
 *
 * Order of operations is chosen so that a failure part-way through never loses
 * a stage: park, then delete what the admin removed, then update, then insert.
 * A crash mid-sequence leaves rows with parked order values — visibly wrong
 * order, fully recoverable by saving again — rather than an empty pipeline.
 */
export async function replaceStagesForService(
  serviceType: string,
  stages: StageRow[],
): Promise<void> {
  if (!serviceType || !serviceType.trim()) {
    throw new Error("replaceStagesForService: serviceType is required")
  }

  // Nothing is written until the draft is known-good. A blank or duplicated
  // stage name used to be accepted and only became a problem later.
  const invalid = validateStageDraft(stages)
  if (invalid) throw new Error(invalid)

  const { data: existingRaw, error: readErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("id, stage_name, stage_order")
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (readErr) {
    throw new Error(`replaceStagesForService(${serviceType}) read: ${readErr.message}`)
  }
  const existing = (existingRaw ?? []) as Array<{ id: string; stage_name: string; stage_order: number }>
  const existingIds = new Set(existing.map(r => r.id))

  // A submitted id that no longer exists means the row was deleted by someone
  // else since the page loaded. Treat it as new rather than updating nothing.
  const submitted = stages.map(s => ({ ...s, id: s.id && existingIds.has(s.id) ? s.id : undefined }))
  const keptIds = new Set(submitted.map(s => s.id).filter(Boolean))

  // 1. Park every existing row clear of the final range so reordering cannot
  //    collide on the (service_type, stage_order) unique index.
  for (let idx = 0; idx < existing.length; idx++) {
    const row = existing[idx]
    const { error } = await supabaseAdmin
      .from("pipeline_stages")
      .update({ stage_order: PARK_OFFSET + idx })
      .eq("id", row.id)
    if (error) {
      throw new Error(`replaceStagesForService(${serviceType}) reorder: ${error.message}`)
    }
  }

  // 2. Remove the stages the admin deleted. Explicit act, so no guard here —
  //    but it happens BEFORE the updates so a later failure cannot strand a
  //    half-written pipeline behind rows that should be gone.
  const removed = existing.filter(r => !keptIds.has(r.id))
  if (removed.length > 0) {
    const { error } = await supabaseAdmin
      .from("pipeline_stages")
      .delete()
      .in("id", removed.map(r => r.id))
    if (error) {
      throw new Error(`replaceStagesForService(${serviceType}) delete: ${error.message}`)
    }
  }

  // 3. Update surviving rows in place. ONLY editor-authored columns appear
  //    here — that is what makes the workspace layout and client labels
  //    untouchable by a Save.
  for (let idx = 0; idx < submitted.length; idx++) {
    const s = submitted[idx]
    if (!s.id) continue
    const { error } = await supabaseAdmin
      .from("pipeline_stages")
      .update({
        stage_order: idx + 1,
        stage_name: s.stage_name.trim(),
        stage_description: s.stage_description ?? null,
        sla_days: s.sla_days ?? null,
        auto_advance: s.auto_advance ?? false,
        notify_client_email: s.notify_client_email ?? false,
        client_description: s.client_description ?? null,
        auto_actions: (s.auto_actions ?? null) as Json,
      })
      .eq("id", s.id)
    if (error) {
      throw new Error(`replaceStagesForService(${serviceType}) update: ${error.message}`)
    }
  }

  // 4. Insert the genuinely new stages.
  const insertRows = submitted
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !s.id)
    .map(({ s, idx }) => ({
      service_type: serviceType,
      stage_order: idx + 1,
      stage_name: s.stage_name.trim(),
      stage_description: s.stage_description ?? null,
      sla_days: s.sla_days ?? null,
      auto_advance: s.auto_advance ?? false,
      notify_client_email: s.notify_client_email ?? false,
      client_description: s.client_description ?? null,
      auto_actions: (s.auto_actions ?? null) as Json,
    }))
  if (insertRows.length > 0) {
    const { error } = await supabaseAdmin.from("pipeline_stages").insert(insertRows)
    if (error) {
      throw new Error(`replaceStagesForService(${serviceType}) insert: ${error.message}`)
    }
  }
}

/**
 * Re-key a service's stages when the admin renames the pipeline itself.
 *
 * The pipeline name IS the `service_type` key. Without this, renaming it made
 * the write path look for rows under a name that has none: it would insert a
 * fresh bare set and leave the real rows orphaned under the old name, with
 * every in-flight service delivery still pointing at it. That is the same total
 * loss the rest of this file exists to prevent, through a different door.
 */
export async function renameServiceTypeForStages(
  oldServiceType: string,
  newServiceType: string,
): Promise<void> {
  if (!oldServiceType?.trim() || !newServiceType?.trim()) return
  if (oldServiceType === newServiceType) return

  const { error } = await supabaseAdmin
    .from("pipeline_stages")
    .update({ service_type: newServiceType })
    .eq("service_type", oldServiceType)
  if (error) {
    throw new Error(`renameServiceTypeForStages(${oldServiceType} -> ${newServiceType}): ${error.message}`)
  }
}
