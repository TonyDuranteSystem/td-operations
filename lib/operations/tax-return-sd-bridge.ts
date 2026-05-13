/**
 * Tax Return ↔ Service Delivery bridge (Phase 3 — SD Pipeline).
 *
 * Two responsibilities:
 *   1. Map a `tax_returns.status` value to its canonical Tax Return SD stage.
 *   2. Ensure that any `tax_returns` row has a matching active `service_deliveries`
 *      row at the corresponding stage — creating one if missing, advancing one
 *      if present.
 *
 * Why this exists:
 *   The Tax Return tab on /tax-returns drives status changes via
 *   `updateTaxReturnStatus`. Before Phase 3, that path only wrote
 *   `tax_returns.status`, bypassing the SD pipeline entirely — no portal
 *   notification, no auto-tasks, no stage_history. Phase 3 routes every
 *   status change through `advanceServiceDelivery` so the tab and the
 *   pipeline-stepper trigger the same downstream effects.
 *
 * Mapping rationale (TR status → SD stage, post-redesign 2026-05-13):
 *   Verified against the live sandbox `tax_return_status` enum (13 values
 *   incl. 'Wizard Available') and `pipeline_stages` rows for
 *   `service_type='Tax Return'` (9 stages, 1..9). The pre-redesign pipeline
 *   had stage_order=-1 ("Company Data Pending") and stage_order=0 ("Paid -
 *   Awaiting Data"); both are removed. The annual Tax Return SD now enters
 *   at stage_order=1 ("1st Installment Paid"). Standalone One-Time clients
 *   use service_type='Tax Return One-Time' (separate pipeline).
 *   Extension states share stage_order=2 ("Extension Filed") since the SD
 *   pipeline has no separate "Requested" stage. "Sent to India" maps to
 *   stage_order=6 ("Preparation") — the accountant is preparing the return.
 *   Legacy enum values ('Activated - Need Link', 'Link Sent - Awaiting
 *   Data', 'Paid - Not Started') are retained for backwards compat with
 *   historical rows and map forward to the closest live stage.
 *
 * The inverse map (SD stage → TR status) lives in
 * `lib/service-delivery.ts::advanceServiceDelivery` step 9. When the bridge
 * calls `advanceStage` with actor="tax-return-tab" the inverse map is
 * SKIPPED to avoid a feedback loop overwriting the user-chosen status.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createSD, advanceStage } from "@/lib/operations/service-delivery"

export const TAX_RETURN_SD_ACTOR = "tax-return-tab"

export interface TaxReturnSDStage {
  stage_name: string
  stage_order: number
}

/**
 * Canonical TR status → SD stage map (post-redesign 2026-05-13). Keys are
 * literal `tax_return_status` enum values; values point at the post-redesign
 * Annual pipeline stages (1..9). Returns null for any value not in this map
 * (defensive — shouldn't happen at runtime).
 *
 * Legacy keys map forward to live stages so historical tax_returns rows
 * still produce valid SD targets:
 *   - "Paid - Not Started"      → "1st Installment Paid" (1)
 *   - "Activated - Need Link"   → "Extension Filed"      (2)
 *   - "Link Sent - Awaiting Data" → "Wizard Available"   (4)
 *   - "Not Invoiced"            → "Payment Pending" stage of One-Time
 *                                  pipeline is the better fit, but we keep
 *                                  Annual context here and map to "1st
 *                                  Installment Paid" (1) so the SD can be
 *                                  reasoned about. Callers must verify the
 *                                  account is on the Annual pipeline.
 */
const TAX_RETURN_STATUS_TO_SD_STAGE: Record<string, TaxReturnSDStage> = {
  "Payment Pending":                    { stage_name: "1st Installment Paid", stage_order: 1 },
  "Not Invoiced":                       { stage_name: "1st Installment Paid", stage_order: 1 },
  "Paid - Not Started":                 { stage_name: "1st Installment Paid", stage_order: 1 },
  "Activated - Need Link":              { stage_name: "Extension Filed",      stage_order: 2 },
  "Extension Requested":                { stage_name: "Extension Filed",      stage_order: 2 },
  "Extension Filed":                    { stage_name: "Extension Filed",      stage_order: 2 },
  "Link Sent - Awaiting Data":          { stage_name: "Wizard Available",     stage_order: 4 },
  "Wizard Available":                   { stage_name: "Wizard Available",     stage_order: 4 },
  "Data Received":                      { stage_name: "Data Received",        stage_order: 5 },
  "Sent to India":                      { stage_name: "Preparation",          stage_order: 6 },
  "TR Completed - Awaiting Signature":  { stage_name: "TR Completed",         stage_order: 7 },
  "TR Filed":                           { stage_name: "TR Filed",             stage_order: 8 },
}

export function mapTaxReturnStatusToSDStage(status: string | null | undefined): TaxReturnSDStage | null {
  if (!status) return null
  return TAX_RETURN_STATUS_TO_SD_STAGE[status] ?? null
}

export interface SyncTaxReturnSDResult {
  action: "noop" | "created" | "advanced" | "skipped"
  delivery_id?: string
  from_stage?: string
  to_stage?: string
  reason?: string
}

/**
 * Ensure the tax_return's account has an active Tax Return SD at the stage
 * corresponding to the TR's current status.
 *
 * Behavior:
 *   - If the TR status doesn't map to any SD stage → skipped.
 *   - If no active (non-cancelled) Tax Return SD exists for the account
 *     → createSD with the mapped stage.
 *   - If an active SD exists at a different stage → advanceStage to the
 *     mapped stage with actor="tax-return-tab".
 *   - If the SD is already at the mapped stage → noop.
 *
 * The function never throws on SD-layer failure — it returns a result with
 * action="skipped" and a reason. The caller (updateTaxReturnStatus) should
 * not let SD wiring failures roll back the TR status update.
 */
export async function syncTaxReturnToSD(taxReturnId: string): Promise<SyncTaxReturnSDResult> {
  const { data: tr, error: trErr } = await supabaseAdmin
    .from("tax_returns")
    .select("id, account_id, contact_id, status, company_name, tax_year")
    .eq("id", taxReturnId)
    .maybeSingle()

  if (trErr || !tr) {
    return { action: "skipped", reason: `tax_returns lookup failed: ${trErr?.message || "not found"}` }
  }

  const target = mapTaxReturnStatusToSDStage(tr.status)
  if (!target) {
    return { action: "skipped", reason: `no SD stage mapping for status="${tr.status}"` }
  }

  if (!tr.account_id) {
    return { action: "skipped", reason: "tax_returns row has no account_id" }
  }

  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, stage, stage_order, status")
    .eq("account_id", tr.account_id)
    .eq("service_type", "Tax Return")
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sdErr) {
    return { action: "skipped", reason: `service_deliveries lookup failed: ${sdErr.message}` }
  }

  if (!sd) {
    try {
      const taxYear = tr.tax_year ?? new Date().getFullYear()
      const companyName = tr.company_name || `account ${tr.account_id}`
      const created = await createSD({
        service_type: "Tax Return",
        service_name: `Tax Return ${taxYear} - ${companyName}`,
        account_id: tr.account_id,
        contact_id: tr.contact_id,
        target_stage: target.stage_name,
        target_stage_order: target.stage_order,
        notes: `Auto-created from tax-return tab on status="${tr.status}".`,
      })
      return { action: "created", delivery_id: created.id, to_stage: target.stage_name }
    } catch (e) {
      return { action: "skipped", reason: `createSD failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  if (sd.stage === target.stage_name && sd.stage_order === target.stage_order) {
    return { action: "noop", delivery_id: sd.id, to_stage: target.stage_name }
  }

  try {
    const result = await advanceStage({
      delivery_id: sd.id,
      target_stage: target.stage_name,
      actor: TAX_RETURN_SD_ACTOR,
    })
    if (!result.success) {
      return {
        action: "skipped",
        delivery_id: sd.id,
        from_stage: sd.stage || undefined,
        to_stage: target.stage_name,
        reason: result.error || "advanceStage returned success=false",
      }
    }
    return {
      action: "advanced",
      delivery_id: sd.id,
      from_stage: result.from_stage,
      to_stage: result.to_stage,
    }
  } catch (e) {
    return {
      action: "skipped",
      delivery_id: sd.id,
      from_stage: sd.stage || undefined,
      to_stage: target.stage_name,
      reason: `advanceStage threw: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
