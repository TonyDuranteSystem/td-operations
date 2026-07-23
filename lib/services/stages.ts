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
   * the admin just added. This ONE field is what lets a Save UPDATE the row in
   * place instead of deleting and recreating it — which is why a Save can no
   * longer destroy the workspace and labels the editor never displays. Without
   * it the write path could only match old row to new row by NAME.
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
 * Stage order is UNIQUE per service_type (`pipeline_stages_service_type_stage_order_key`,
 * verified on both production and sandbox), so a reorder cannot assign final
 * positions one row at a time — an intermediate state collides. Rows whose order
 * must change are parked clear of the live range first.
 *
 * The park base is computed from the data, never a constant. A fixed constant
 * deadlocks: if a save dies part-way through parking, the leftovers occupy the
 * bottom of the park band, and the next save — which reads rows ordered by
 * stage_order, so the unparked rows now sort FIRST — tries to park a row onto a
 * value a leftover still holds. Every retry then fails identically and the
 * service can never be saved again without hand-editing the database.
 * Reproduced before this was fixed.
 */
const PARK_FLOOR = 100000

/**
 * Statuses that mean the delivery is FINISHED. Anything else is live work that
 * would be stranded if its stage disappeared.
 *
 * Defined as "not terminal" rather than a list of live values on purpose: the
 * table currently holds active, completed, cancelled, blocked, inactive AND two
 * rows spelled "Active" with a capital A. A guard that matched only "active"
 * exactly would have missed all 135 blocked deliveries and those two rows.
 */
export const TERMINAL_DELIVERY_STATUSES = ["completed", "cancelled", "canceled", "inactive"] as const
const TERMINAL_SET = new Set<string>(TERMINAL_DELIVERY_STATUSES)

export function isLiveDeliveryStatus(status: string | null | undefined): boolean {
  if (!status) return true // unknown state — treat as live and refuse to destroy
  return !TERMINAL_SET.has(status.trim().toLowerCase())
}

/** Validation that must happen BEFORE anything is written. */
export function validateStageDraft(stages: StageRow[]): string | null {
  const seen = new Set<string>()
  const seenIds = new Set<string>()
  for (let idx = 0; idx < stages.length; idx++) {
    const name = (stages[idx].stage_name ?? "").trim()
    if (!name) {
      return `Stage ${idx + 1} has no name. Every stage needs a name before you can save.`
    }
    if (seen.has(name.toLowerCase())) {
      return `Two stages are both called "${name}". Stage names must be unique within a service.`
    }
    seen.add(name.toLowerCase())
    // Two entries sharing an id would silently merge into one row.
    const id = stages[idx].id
    if (id) {
      if (seenIds.has(id)) return `The same stage appears twice in this draft. Reload the page and try again.`
      seenIds.add(id)
    }
  }
  return null
}

/**
 * Choose the stage_order for each submitted stage, PRESERVING the pipeline's own
 * numbering scale.
 *
 * Stage order is not cosmetic and it is not dense. Tax Return runs -10..90 with
 * deliberate gaps, and `resolveSecondInstallmentAdvance` above filters on
 * `stage_order >= 1` — that filter is the ONLY thing preventing a second
 * installment payment from auto-advancing a delivery past the intake stages that
 * carry negative orders. Renumbering every save to a dense 1..n (which both the
 * original implementation and the first rewrite did) silently moves intake
 * stages to positive numbers and changes what a money event does.
 *
 * So: reuse the order values the SURVIVING stages already hold, assigned in the
 * admin's chosen sequence. Stages added on top extend the scale beyond the
 * current maximum.
 *
 * The pool MUST come from the stages that remain, never from every stage that
 * existed. Pooling the deleted ones too makes every surviving stage slide down
 * one slot: with orders -10,-5,1,10,20,30 and the first stage deleted, the stage
 * that sat at 1 lands on -5 and drops out of the `>= 1` set that decides whether
 * a second installment may auto-advance a client. Deleting an unrelated stage
 * would silently change what a payment does. Leaving gaps is correct — the
 * scale is already gapped by design.
 */
export function planStageOrders(
  submittedCount: number,
  survivingOrders: number[],
): number[] {
  const pool = [...survivingOrders].sort((a, b) => a - b)
  const out: number[] = []
  let next = pool.length > 0 ? pool[pool.length - 1] : 0
  for (let i = 0; i < submittedCount; i++) {
    if (i < pool.length) out.push(pool[i])
    else {
      next += 10 // extend the scale rather than compressing it
      out.push(next)
    }
  }
  return out
}

/**
 * Reconcile a service's stages against what the editor submitted.
 *
 * WHY THIS IS NOT delete-then-insert (2026-07-22). It used to delete every row
 * for the service_type and re-insert only the nine columns the editor authors.
 * The row has twenty-three. Everything else — the entire staff workspace
 * descriptor (components, buttons, advance targets), the client-facing labels
 * the portal renders, the board and portal display settings — was destroyed on
 * every Save. One Save on ITIN, even just an SLA day count, would have erased
 * all eight ITIN workspaces.
 *
 * The defect was upstream of the write: the loader did not select the row id, so
 * identity was discarded before the editor ever saw the stages and the write had
 * nothing but names to match on. Carrying the id through means rows are UPDATED
 * IN PLACE, and columns the editor does not author are never named in any
 * statement — so they cannot be lost by oversight, nor by a future column nobody
 * remembers to protect.
 *
 * `knownStageIds` is the set of row ids the editor had when the page loaded. A row
 * that exists now but was NOT in that set was created by someone else since —
 * a second tab, another admin, the /config stage editor — and saving would
 * delete it as "absent from the submission". That is refused instead.
 *
 * Order of operations: validate, read, refuse-if-unsafe, park, delete, update,
 * insert. Every failure point leaves stages present, never an empty pipeline.
 */
export async function replaceStagesForService(
  serviceType: string,
  stages: StageRow[],
  opts: { knownStageIds?: string[] } = {},
): Promise<{ warnings: string[] }> {
  if (!serviceType || !serviceType.trim()) {
    throw new Error("replaceStagesForService: serviceType is required")
  }

  const invalid = validateStageDraft(stages)
  if (invalid) throw new Error(invalid)

  const warnings: string[] = []

  const { data: existingRaw, error: readErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("id, stage_name, stage_order")
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (readErr) {
    throw new Error(`replaceStagesForService(${serviceType}) read: ${readErr.message}`)
  }
  const existing = (existingRaw ?? []) as Array<{ id: string; stage_name: string; stage_order: number }>
  const existingById = new Map(existing.map(r => [r.id, r]))

  // A submitted id that no longer exists was deleted by someone else; treat it
  // as new rather than updating nothing.
  const submitted = stages.map(s => ({
    ...s,
    stage_name: s.stage_name.trim(),
    id: s.id && existingById.has(s.id) ? s.id : undefined,
  }))
  const keptIds = new Set(submitted.map(s => s.id).filter(Boolean) as string[])

  // STALE EDIT — both directions.
  //
  // APPEARED: a stage exists now that this page never saw. Saving would delete
  // it as "absent from the submission".
  //
  // VANISHED: a stage this page loaded has been deleted elsewhere, but is still
  // in the draft. Its id no longer resolves, so it would fall through to INSERT
  // and come back as a BARE row — no workspace, no client label. That is the
  // exact loss this whole change exists to prevent, arriving through the back
  // door. Refuse both.
  if (opts.knownStageIds) {
    const known = new Set(opts.knownStageIds)
    // A row whose id is in THIS submission is one we just created ourselves —
    // the page's frozen load-time list will not contain it, but it is not
    // another session's work. Without this, the ordinary loop "add a step, save,
    // fix a typo, save again" refuses the second save and blames a tab that does
    // not exist.
    const submittedIds = new Set(stages.map(x => x.id).filter(Boolean) as string[])
    const appeared = existing.filter(r => !known.has(r.id) && !submittedIds.has(r.id))
    if (appeared.length > 0) {
      throw new Error(
        `This service's stages were changed somewhere else while this page was open ` +
          `(${appeared.map(r => `"${r.stage_name}"`).join(", ")} ${appeared.length === 1 ? "was" : "were"} added). ` +
          `Nothing has been changed here — reload the page and make your edit again.`,
      )
    }
    const vanished = stages.filter(s => s.id && known.has(s.id) && !existingById.has(s.id))
    if (vanished.length > 0) {
      throw new Error(
        `${vanished.map(s => `"${s.stage_name}"`).join(", ")} ${vanished.length === 1 ? "was" : "were"} ` +
          `deleted somewhere else while this page was open. Saving would recreate ` +
          `${vanished.length === 1 ? "it" : "them"} without the staff workspace. ` +
          `Nothing has been changed here — reload the page.`,
      )
    }
  }

  const removed = existing.filter(r => !keptIds.has(r.id))

  // Clearing EVERY step of a pipeline that has some is almost certainly a form
  // that failed to load, not an intention. The workspaces it would destroy
  // cannot be retyped.
  if (existing.length > 0 && submitted.length === 0) {
    throw new Error(
      `This save would remove all ${existing.length} steps from ${serviceType} and delete ` +
        `their staff workspaces. If that is really what you want, remove them one at a ` +
        `time. Nothing has been changed.`,
    )
  }

  // A stage cannot be deleted while live work sits on it: service deliveries
  // record their stage by NAME, so the delivery would be stranded on a stage
  // that no longer exists and could not be advanced or reverted by any UI path.
  if (removed.length > 0) {
    const { data: blockers, error: blockErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("stage, status")
      .eq("service_type", serviceType)
      .in("stage", removed.map(r => r.stage_name))
    if (blockErr) {
      throw new Error(`replaceStagesForService(${serviceType}) delivery check: ${blockErr.message}`)
    }
    const live = (blockers ?? []).filter(b => isLiveDeliveryStatus((b as { status: string }).status))
    if (live.length > 0) {
      const counts = new Map<string, number>()
      for (const b of live as Array<{ stage: string }>) {
        counts.set(b.stage, (counts.get(b.stage) ?? 0) + 1)
      }
      const detail = Array.from(counts.entries())
        .map(([stage, n]) => `"${stage}" (${n} active)`)
        .join(", ")
      throw new Error(
        `Cannot delete ${detail}: clients are currently on ${counts.size === 1 ? "that stage" : "those stages"} and ` +
          `would be stranded with no way to move them forward. Move them to another stage first. ` +
          `Nothing has been changed.`,
      )
    }
  }

  // Renaming a stage leaves live deliveries pointing at the old name, so re-key
  // them in the same operation. Narrow by design: exact old name, this service
  // only, active rows only. History rows are deliberately NOT rewritten — they
  // must keep saying what they said at the time.
  // RENAMING A STEP IS NOT AVAILABLE FROM THIS SCREEN, deliberately (2026-07-23).
  //
  // Stage names are not just labels: they are matched literally by code that
  // decides real client outcomes. "Wizard Available" gates whether a paying tax
  // client's wizard opens, and that check is fail-closed — rename the stage and
  // the wizard silently shuts for everyone. "Client Signing" is what surfaces a
  // client's ITIN documents in the portal. "SS-4 Prepared" drives a reminder
  // sweep. Moving the deliveries and the buttons is not enough while those
  // literals exist in code, and a warning cannot undo a closed wizard.
  //
  // This was never safe — before this change a rename also destroyed every
  // workspace. Refusing is a capability cut, not a regression.
  const renames: Array<{ from: string; to: string }> = []
  for (const s of submitted) {
    if (!s.id) continue
    const before = existingById.get(s.id)
    if (before && before.stage_name !== s.stage_name) {
      renames.push({ from: before.stage_name, to: s.stage_name })
    }
  }
  if (renames.length > 0) {
    throw new Error(
      `Renaming a step is not available yet — ${renames.map(r => `"${r.from}"`).join(", ")} ` +
        `${renames.length === 1 ? "is" : "are"} matched by name elsewhere in the system, and ` +
        `renaming can silently close a client's wizard or hide their documents. ` +
        `Nothing has been changed.`,
    )
  }

  // Final orders, preserving the pipeline's scale (see planStageOrders).
  //
  // Values in the park band are NOT part of the scale — they are debris from a
  // save that died mid-reorder. Feeding them back in would adopt them as the
  // pipeline's real numbering, leaving steps numbered 100001 for ever. Drop
  // them and let planStageOrders extend the surviving scale instead.
  // Only the SURVIVING stages contribute their numbers — see planStageOrders.
  const livePool = existing
    .filter(r => keptIds.has(r.id))
    .map(r => r.stage_order)
    .filter(o => o < PARK_FLOOR)
  const plannedOrders = planStageOrders(submitted.length, livePool)
  // REORDERING IS NOT AVAILABLE FROM THIS SCREEN, deliberately (2026-07-23).
  //
  // Moving a step needs three things this change does not do: live deliveries
  // store their own copy of the step NUMBER and use it to resolve "the next
  // step", so a reorder makes Advance skip or repeat stages unless those are
  // re-synced (every past renumbering migration did that by hand); inserting a
  // step anywhere but the end slides its neighbours onto other numbers, which
  // can push an intake step across the boundary that decides whether a payment
  // auto-advances a client; and a save interrupted mid-reorder cannot restore
  // the original sequence, because the parked numbers carry no record of where
  // each step came from.
  //
  // None of that was safe before this change either — reordering used to
  // renumber the whole pipeline and destroy every workspace with it. Refusing is
  // a capability cut, not a regression. Renaming, editing and appending are
  // safe and remain available.
  const movedRows = submitted
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.id && existingById.get(s.id)!.stage_order !== plannedOrders[i])
  if (movedRows.length > 0) {
    throw new Error(
      `Changing the ORDER of steps is not available yet — moving a step would leave ` +
        `clients already on it pointing at the wrong place. You can edit a step's ` +
        `details, add a step at the end, or remove one. Nothing has been changed.`,
    )
  }
  const needsOrderChange = submitted.some(s => !s.id) // only genuinely new rows
  // Debris from an interrupted save must be cleared even if nothing else moved.
  const hasParkDebris = existing.some(r => r.stage_order >= PARK_FLOOR)

  // 1. PARK — only when an order actually moves, and always above everything
  //    currently in the table so a half-finished park can never block a retry.
  if ((needsOrderChange || hasParkDebris) && existing.length > 0) {
    const base = Math.max(PARK_FLOOR, ...existing.map(r => r.stage_order)) + 1
    for (let idx = 0; idx < existing.length; idx++) {
      const row = existing[idx]
      const { error } = await supabaseAdmin
        .from("pipeline_stages")
        .update({ stage_order: base + idx })
        .eq("id", row.id)
      if (error) {
        throw new Error(`replaceStagesForService(${serviceType}) reorder: ${error.message}`)
      }
    }
  }

  // 2. DELETE what the admin removed — recording it first, because the row
  //    carries content the editor never showed and cannot be retyped.
  if (removed.length > 0) {
    const { data: doomed } = await supabaseAdmin
      .from("pipeline_stages")
      .select("*")
      .in("id", removed.map(r => r.id))
    const { error } = await supabaseAdmin
      .from("pipeline_stages")
      .delete()
      .in("id", removed.map(r => r.id))
    if (error) {
      throw new Error(`replaceStagesForService(${serviceType}) delete: ${error.message}`)
    }
    await logStageDeletion(serviceType, doomed ?? [])

    // Same hazard as a rename: another stage's advance button may name this one.
    for (const r of removed) {
      const refs = await stagesReferencing(serviceType, r.stage_name)
      if (refs.length > 0) {
        warnings.push(
          `"${refs.join('", "')}" still ${refs.length === 1 ? "has a button" : "have buttons"} ` +
            `pointing at the deleted stage "${r.stage_name}". Those buttons will fail until the workspace is updated.`,
        )
      }
    }
  }

  // 3. UPDATE survivors in place. ONLY editor-authored columns appear here —
  //    that is what makes the workspace and client labels untouchable by a Save.
  for (let idx = 0; idx < submitted.length; idx++) {
    const s = submitted[idx]
    if (!s.id) continue
    const { error } = await supabaseAdmin
      .from("pipeline_stages")
      .update({
        stage_order: plannedOrders[idx],
        stage_name: s.stage_name,
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

  // 4. INSERT the genuinely new stages.
  const insertRows = submitted
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => !s.id)
    .map(({ s, idx }) => ({
      service_type: serviceType,
      stage_order: plannedOrders[idx],
      stage_name: s.stage_name,
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

  return { warnings }
}

/** Record what a stage deletion destroyed — the row carries content the editor never showed. */
async function logStageDeletion(serviceType: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return
  try {
    await supabaseAdmin.from("action_log").insert(
      rows.map(row => {
        const r = row as { id?: string; stage_name?: string; stage_layout?: unknown }
        return {
          action_type: "delete",
          table_name: "pipeline_stages",
          record_id: r.id ?? null,
          summary:
            `Deleted stage "${r.stage_name ?? "?"}" from the ${serviceType} pipeline` +
            (r.stage_layout ? " (its staff workspace was deleted with it)" : ""),
          details: { service_type: serviceType, deleted_row: row } as unknown as Json,
        }
      }),
    )
  } catch {
    // Never let the audit write fail the save — the deletion already happened.
  }
}

/** Stage names whose stage_layout still names `target` in an action button. */
async function stagesReferencing(serviceType: string, target: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("pipeline_stages")
    .select("stage_name, stage_layout")
    .eq("service_type", serviceType)
  const hits: string[] = []
  for (const row of (data ?? []) as Array<{ stage_name: string; stage_layout: unknown }>) {
    if (JSON.stringify(row.stage_layout ?? "").includes(`"target":"${target}"`) ||
        JSON.stringify(row.stage_layout ?? "").includes(`"target": "${target}"`)) {
      hits.push(row.stage_name)
    }
  }
  return hits
}
