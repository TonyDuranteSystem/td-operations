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
      "stage_order, stage_name, stage_description, sla_days, auto_advance, notify_client_email, client_description, auto_actions",
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
 * Columns `replaceStagesForService` writes itself. The admin's edit always wins
 * for these, so they are never carried forward from the old row.
 *
 * MUST stay in step with the keys built in `insertRows`. A unit test asserts the
 * two are identical — if you add a field to the insert, that test fails until
 * you add it here, which is the point: a column in both places would let a
 * stale database value silently beat the admin's edit.
 */
export const EDITOR_OWNED_COLUMNS = new Set([
  "service_type",
  "stage_order",
  "stage_name",
  "stage_description",
  "sla_days",
  "auto_advance",
  "notify_client_email",
  "client_description",
  "auto_actions",
])

/**
 * Never carried, for reasons other than editor ownership.
 *
 * `id` / `created_at` — the new rows are new rows.
 * `service_type_entry_id` — a derived mirror of `service_type` under a foreign
 *   key. Carrying a stale value made the INSERT able to fail on that FK AFTER
 *   the DELETE had committed, leaving the service with no stages at all: a fix
 *   that could cause the very loss it was written to prevent.
 */
export const NEVER_CARRIED_COLUMNS = new Set(["id", "created_at", "service_type_entry_id"])

type CarriedRow = Record<string, unknown>

/**
 * Replace ALL stages for a service_type atomically (delete-then-insert).
 *
 * Why replace rather than diff: stage_order is critical and indexed; a partial
 * update with reordering means temporary unique-constraint violations. Delete
 * + bulk insert avoids that and matches existing migration patterns.
 *
 * Concurrency: the editor isn't multi-user-per-row (admin-only, low volume).
 * If two admins edit the same service's stages concurrently, last-write wins.
 * Acceptable at our scale.
 *
 * CARRY-FORWARD (2026-07-22). The editor authors only the fields in `StageRow`.
 * Everything else on the row — the whole staff workspace descriptor, the
 * client-facing labels, the board/portal display settings — is authored by
 * migration and is invisible to the editor. Delete-then-insert used to drop all
 * of it: one Save on the ITIN service, even just changing an SLA day count,
 * erased all eight ITIN workspace layouts (components, buttons, advance
 * targets) and left the staff page an empty stub. The natural recovery was
 * replaying the seed migration, which would ALSO have re-planted a stale
 * hardcoded office address — so the wipe and the address regression were one
 * accident.
 *
 * Two deliberate choices, both from council review of an earlier cut:
 *
 * 1. The carried set is DERIVED, never listed: "every column on the existing
 *    row, minus the ones this function writes itself, minus row identity". A
 *    hand-written allowlist rots silently — someone adds a column, forgets the
 *    list, and the wipe returns a year later with every test still green. This
 *    cannot rot, because the only list it depends on is the one this function
 *    already writes.
 *
 * 2. It REFUSES rather than guesses. Carry-forward can only match old row to new
 *    row by stage_name, so a rename has no correct answer. Guessing is worse
 *    than the original bug: renaming two stages in one save would cross-wire
 *    their workspaces, giving each stage the other's buttons and advance
 *    targets — a plausible-looking WRONG workspace on the stage where a client's
 *    original passport and wet-ink W-7 are in the post. A wipe is visible and
 *    gets reported; a cross-wire is not. So a save that would strand content
 *    throws before touching anything, naming exactly what would be lost.
 */
export async function replaceStagesForService(
  serviceType: string,
  stages: StageRow[],
  opts: { allowContentLoss?: boolean } = {},
): Promise<void> {
  if (!serviceType || !serviceType.trim()) {
    throw new Error("replaceStagesForService: serviceType is required")
  }

  // Read the whole existing row set BEFORE the delete, so a Save cannot silently
  // destroy what the editor cannot see. `select("*")` is what makes the carried
  // set derived rather than a list that rots.
  const { data: existingRaw, error: readErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("*")
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (readErr) {
    throw new Error(`replaceStagesForService(${serviceType}) read: ${readErr.message}`)
  }
  const existing = (existingRaw ?? []) as unknown as CarriedRow[]

  // Duplicate stage_name makes carry-forward ambiguous. There is no unique index
  // on (service_type, stage_name) — only on (service_type, stage_order),
  // verified against production — and the editor's name field is free text, so
  // duplicates are reachable. Refuse rather than let one stage's workspace
  // silently overwrite the other's.
  const seenNames = new Set<string>()
  for (const row of existing) {
    const name = typeof row.stage_name === "string" ? row.stage_name : ""
    if (seenNames.has(name)) {
      throw new Error(
        `replaceStagesForService(${serviceType}): two existing stages are both named ` +
          `"${name}". Rename one in the database before saving — carry-forward cannot tell ` +
          `which stage's workspace layout belongs to which.`,
      )
    }
    seenNames.add(name)
  }

  const carried = new Map<string, CarriedRow>()
  for (const row of existing) {
    if (typeof row.stage_name !== "string") continue
    const keep: CarriedRow = {}
    for (const [col, value] of Object.entries(row)) {
      if (EDITOR_OWNED_COLUMNS.has(col)) continue // the admin's edit always wins
      if (NEVER_CARRIED_COLUMNS.has(col)) continue // identity + derived FK
      if (value === null || value === undefined) continue
      keep[col] = value
    }
    if (Object.keys(keep).length > 0) carried.set(row.stage_name, keep)
  }

  // Refuse any save that would strand content. Covers BOTH the rename case (a
  // stage carrying a layout is not in the incoming set) and clearing every stage
  // at once — the same loss by a different door, and the path that made an
  // earlier cut of this fix useless. `allowContentLoss` is the escape hatch for
  // a caller that genuinely means it.
  if (!opts.allowContentLoss) {
    const incoming = new Set(stages.map(s => s.stage_name))
    const stranded = [...carried.keys()].filter(name => !incoming.has(name))
    if (stranded.length > 0) {
      throw new Error(
        `replaceStagesForService(${serviceType}): this save would permanently delete the ` +
          `workspace layout and client-facing settings for ${stranded.length} stage(s): ` +
          `${stranded.join(", ")}. If you renamed a stage, the layout cannot follow the ` +
          `rename automatically — keep the old name, or have the layout re-applied after ` +
          `saving. Nothing has been changed.`,
      )
    }
  }

  // Delete existing rows for this service_type.
  const { error: delErr } = await supabaseAdmin
    .from("pipeline_stages")
    .delete()
    .eq("service_type", serviceType)
  if (delErr) {
    throw new Error(`replaceStagesForService(${serviceType}) delete: ${delErr.message}`)
  }

  if (stages.length === 0) return

  // Insert new rows. Stage_order is set from the array index + 1 to guarantee
  // density (no gaps), regardless of what the editor passed.
  const insertRows = stages.map((s, idx) => ({
    service_type: serviceType,
    stage_order: idx + 1,
    stage_name: s.stage_name,
    stage_description: s.stage_description ?? null,
    sla_days: s.sla_days ?? null,
    auto_advance: s.auto_advance ?? false,
    notify_client_email: s.notify_client_email ?? false,
    client_description: s.client_description ?? null,
    // Preserve the generic rule bag (e.g. second_installment_target) so a
    // full re-author of a service's stages does not silently drop it.
    auto_actions: (s.auto_actions ?? null) as Json,
    // Everything the editor cannot author, carried back onto the new row.
    // Disjoint from the fields above by construction (EDITOR_OWNED_COLUMNS), so
    // this spread can never overwrite an admin's edit.
    ...(carried.get(s.stage_name) ?? {}),
  }))

  const { error: insErr } = await supabaseAdmin.from("pipeline_stages").insert(insertRows)
  if (insErr) {
    throw new Error(`replaceStagesForService(${serviceType}) insert: ${insErr.message}`)
  }
}
