/**
 * Apply a CONFIRMED tax submission (Slice 2, piece 3).
 *
 * This is the work that used to run automatically on submit, now gated behind
 * the client's Confirm (review_status → confirmed). It RELEASES the submission
 * from the review block:
 *   • tax_returns        → data_received=true, status "Data Received"
 *   • service_deliveries → "Data Submitted" (45) advances to "Data Received" (50)
 *
 * CRM contact/account field sync already happens on submit in the submit
 * handlers (low-risk fields, idempotent), so it is intentionally NOT repeated
 * here — this function's job is the forward release only.
 *
 * Non-fatal per step: each write is wrapped so one failure doesn't abort the
 * others. Returns a step log for the caller to surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ApplyConfirmedParams {
  account_id: string | null
  tax_year: number | null
  actor: string
}

export interface ApplyStep {
  step: string
  status: "ok" | "skipped" | "error"
  detail?: string
}

export async function applyConfirmedTaxSubmission(p: ApplyConfirmedParams): Promise<ApplyStep[]> {
  const steps: ApplyStep[] = []
  const now = new Date().toISOString()
  const today = now.slice(0, 10)

  if (!p.account_id) {
    steps.push({ step: "apply", status: "skipped", detail: "no account_id" })
    return steps
  }

  // ─── 1. tax_returns → Data Received ───
  try {
    let q = supabaseAdmin.from("tax_returns").select("id").eq("account_id", p.account_id)
    q = p.tax_year != null ? q.eq("tax_year", p.tax_year) : q.eq("data_received", false)
    const { data: tr } = await q.order("tax_year", { ascending: false }).limit(1).maybeSingle()

    if (tr) {
      const { error } = await supabaseAdmin
        .from("tax_returns")
        .update({ data_received: true, data_received_date: today, status: "Data Received", updated_at: now })
        .eq("id", tr.id)
      steps.push(error
        ? { step: "tax_return", status: "error", detail: error.message }
        : { step: "tax_return", status: "ok", detail: `${tr.id} → Data Received` })
    } else {
      steps.push({ step: "tax_return", status: "skipped", detail: "no tax_returns row" })
    }
  } catch (e) {
    steps.push({ step: "tax_return", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 2. service_deliveries: Data Submitted → Data Received ───
  try {
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage, stage_history")
      .eq("account_id", p.account_id)
      .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
      .eq("status", "active")
      .limit(1)
      .maybeSingle()

    if (sd) {
      const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
      history.push({
        event: "tax_review_confirmed",
        from_stage: sd.stage,
        to_stage: "Data Received",
        advanced_at: now,
        notes: `Client confirmed reviewed tax data (${p.actor})`,
      })
      // Direct write: skip_notify is intentional — this handler owns notifications
      // via emitClientChatEvent. Bypassing advanceStage also avoids double-triggering
      // the workflow dispatcher which fires on stage advance notifications.
      // eslint-disable-next-line no-restricted-syntax
      const { error } = await supabaseAdmin
        .from("service_deliveries")
        .update({ stage: "Data Received", stage_order: 50, stage_entered_at: now, stage_history: history })
        .eq("id", sd.id)
      steps.push(error
        ? { step: "sd", status: "error", detail: error.message }
        : { step: "sd", status: "ok", detail: `${sd.id} → Data Received` })
    } else {
      steps.push({ step: "sd", status: "skipped", detail: "no active Tax Return SD" })
    }
  } catch (e) {
    steps.push({ step: "sd", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  return steps
}
