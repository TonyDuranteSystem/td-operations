/**
 * Sync a flow-workspace "Request Changes" into the tax review state machine
 * (Carasso edit-button fix, 2026-07-23).
 *
 * Called by /api/flows/[id]/advance after a Tax Return service delivery reaches
 * the "Revision Requested" stage. It writes the latest tax submission's
 * `review_status` to `revision_requested` so the portal actually lets the client
 * edit (the gate reads review_status, not the SD stage), records a truthful
 * staff history round, resolves any open What's New card so the resubmit raises a
 * fresh one, and notifies the client in their own language.
 *
 * Design notes:
 *  - Idempotent: a second press (already revision_requested) is a no-op.
 *  - TOCTOU-guarded: the UPDATE pins the prior review_status so a concurrent
 *    writer can't be clobbered.
 *  - Best-effort by contract: the caller treats a thrown error as non-fatal —
 *    the stage advance the staff member saw must not be undone by a sync hiccup.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { buildReviewHistoryEntry, type ReviewStatus } from "@/lib/tax/review-status"
import { decideFlowRevision } from "@/lib/tax/flow-revision"
import { TAX_WIZARD_SERVICE_TYPES } from "@/lib/tax/wizard-eligibility"

export interface SyncTaxRevisionResult {
  status:
    | "written" // review_status set to revision_requested, client notified
    | "already_revision_requested"
    | "confirmed_locked"
    | "no_submission"
    | "not_tax_flow"
    | "no_account"
    | "illegal"
    | "conflict" // a concurrent writer moved the row first
    | "error"
  submissionId?: string
  from?: ReviewStatus | null
  clientNotified?: boolean
  detail?: string
}

export async function syncTaxRevisionRequest(params: {
  serviceDeliveryId: string
  by: string
  note?: string
}): Promise<SyncTaxRevisionResult> {
  const { serviceDeliveryId, by } = params
  const note = params.note?.trim() || undefined

  // 1. Resolve the SD → tax-family + account.
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("service_type, account_id")
    .eq("id", serviceDeliveryId)
    .maybeSingle()
  if (sdErr) return { status: "error", detail: sdErr.message }
  if (!sd) return { status: "error", detail: "service delivery not found" }
  if (!TAX_WIZARD_SERVICE_TYPES.includes(sd.service_type)) return { status: "not_tax_flow" }
  if (!sd.account_id) return { status: "no_account" }

  // 2. Pick the SAME submission the wizard gate will let the client edit, so the
  //    button, the gate, the page prefill and the lock all act on ONE row.
  //    Mirrors decideTaxWizardEligibility's target rule exactly: when an OPEN
  //    tax_returns row exists, the target is the OLDEST open year's latest
  //    submission (back-filing collects oldest first); with no open row, it's the
  //    latest submission overall. Blindly taking the newest row would unlock a
  //    different tax year than the client edits (cross-year contamination for a
  //    returning client with two submissions). (bug-hunter #3, 2026-07-24.)
  const [subsRes, openRes] = await Promise.all([
    supabaseAdmin
      .from("tax_return_submissions")
      .select("id, contact_id, tax_year, review_status, review_history, created_at")
      .eq("account_id", sd.account_id),
    supabaseAdmin
      .from("tax_returns")
      .select("tax_year")
      .eq("account_id", sd.account_id)
      .eq("data_received", false),
  ])
  if (subsRes.error) return { status: "error", detail: subsRes.error.message }
  if (openRes.error) return { status: "error", detail: openRes.error.message }

  const allSubs = subsRes.data ?? []
  const latestOf = <T extends { created_at: string }>(rows: T[]): T | null =>
    rows.length === 0 ? null : rows.reduce((a, b) => (a.created_at >= b.created_at ? a : b))

  const openYears = (openRes.data ?? []).map(r => r.tax_year as number)
  const targetYear = openYears.length > 0 ? Math.min(...openYears) : null
  const sub = targetYear !== null
    ? latestOf(allSubs.filter(s => s.tax_year === targetYear))
    : latestOf(allSubs)

  const current = (sub?.review_status ?? null) as ReviewStatus | null
  const decision = decideFlowRevision(current, !!sub)
  if (!decision.ok) {
    return { status: decision.reason ?? "error", submissionId: sub?.id, from: current }
  }

  // 3. Write review_status + a truthful history round. Pin the prior value so a
  //    concurrent transition (What's New button, a resubmit) can't be clobbered.
  const now = new Date().toISOString()
  const history = Array.isArray(sub!.review_history) ? sub!.review_history : []
  history.push(
    buildReviewHistoryEntry({
      from: decision.from ?? null,
      to: "revision_requested",
      at: now,
      by,
      note: note ?? "Changes requested from the flow workspace",
    }),
  )

  let upd = supabaseAdmin
    .from("tax_return_submissions")
    .update({ review_status: "revision_requested", review_history: history, updated_at: now })
    .eq("id", sub!.id)
  // NULL and a concrete prior value need different guards (`.is` vs `.eq`).
  upd = current === null ? upd.is("review_status", null) : upd.eq("review_status", current)
  const { data: updated, error: updErr } = await upd.select("id")
  if (updErr) return { status: "error", submissionId: sub!.id, detail: updErr.message }
  if (!updated || updated.length === 0) {
    // Someone moved review_status between our read and write — don't force it.
    return { status: "conflict", submissionId: sub!.id, from: current }
  }

  // 4. Resolve any open What's New card so the client's resubmit raises a fresh
  //    one (emitActionNeeded skips while one is open). Best-effort.
  await supabaseAdmin
    .from("message_actions")
    .update({ resolved_at: now })
    .eq("source_ref", `tax_submission:${sub!.id}`)
    .is("resolved_at", null)

  // 5. Notify the client in their own language (chat + email + bell). Best-effort
  //    — a notification failure must not roll back the unlock.
  let clientNotified = false
  try {
    const { notifyClientActionRequired } = await import("@/lib/portal/action-required")
    await notifyClientActionRequired({
      account_id: sd.account_id,
      contact_id: (sub!.contact_id as string | null) ?? null,
      title: {
        en: "Changes needed on your tax submission",
        it: "Modifiche richieste alla tua dichiarazione",
      },
      message: note
        ? {
            en: `Our team reviewed your tax submission and needs a change: ${note}\n\nPlease open your portal, edit your tax information, and resubmit.`,
            it: `Il nostro team ha revisionato la tua dichiarazione e serve una modifica: ${note}\n\nAccedi al portale, correggi le informazioni fiscali e reinvia.`,
          }
        : {
            en: "Our team needs a change on your tax submission. Please open your portal, edit your tax information, and resubmit.",
            it: "Il nostro team ha bisogno di una modifica alla tua dichiarazione. Accedi al portale, correggi le informazioni fiscali e reinvia.",
          },
      // Distinct from the generic "/portal" tax notices (approve / What's New) so
      // the 10-minute action-required dedup — keyed on (type, link, contact) —
      // can never silently drop this "edit your data" message when another tax
      // action fired on the same client in the window. Also deep-links straight
      // to the editable form. (bug-hunter #6, 2026-07-24.)
      link: "/portal/wizard?type=tax",
    })
    clientNotified = true
  } catch (notifyErr) {
    console.error("[sync-flow-revision] client notify failed (non-fatal):", notifyErr)
  }

  return {
    status: "written",
    submissionId: sub!.id,
    from: decision.from,
    clientNotified,
  }
}
