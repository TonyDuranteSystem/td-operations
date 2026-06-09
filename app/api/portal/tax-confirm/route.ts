/**
 * POST /api/portal/tax-confirm — client confirms their reviewed tax submission.
 *
 * Slice 2 piece 3. The Confirm button (Slice 3 UI) posts { submission_id } here.
 * Guard: only a submission the staff have APPROVED can be confirmed
 * (review_status: approved → confirmed). On success the submission locks
 * (read-only) and the apply runs — tax_returns + SD released to "Data Received".
 *
 * Body: { submission_id: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClient } from "@/lib/auth"
import { resolvePortalIdentity } from "@/lib/portal/resolve-portal-identity"
import { canSubmitWizard } from "@/lib/portal/wizard-submit-access"
import { canTransition, buildReviewHistoryEntry, type ReviewStatus } from "@/lib/tax/review-status"
import { applyConfirmedTaxSubmission } from "@/lib/tax/apply-confirmed-submission"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isClient(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const submission_id = (body as { submission_id?: string }).submission_id
  if (!submission_id) {
    return NextResponse.json({ error: "submission_id required" }, { status: 400 })
  }

  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, account_id, contact_id, tax_year, review_status, review_history")
    .eq("id", submission_id)
    .single()
  if (!sub) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 })
  }

  // Isolation: the logged-in client must own this submission (same default-deny
  // check the wizard-submit route uses).
  const identity = await resolvePortalIdentity(user)
  if (!canSubmitWizard(identity, sub.account_id, sub.contact_id ?? null)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 })
  }

  const prev = (sub.review_status ?? null) as ReviewStatus | null
  if (prev !== "approved" || !canTransition(prev, "confirmed")) {
    return NextResponse.json(
      { error: "This submission isn't ready to confirm yet — our team is still reviewing it.", review_status: prev },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const reviewHistory = Array.isArray(sub.review_history) ? sub.review_history : []
  reviewHistory.push(
    buildReviewHistoryEntry({ from: prev, to: "confirmed", at: now, by: `client:${sub.contact_id ?? user.id}` }),
  )

  const { error: rsErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .update({ review_status: "confirmed", review_history: reviewHistory, updated_at: now })
    .eq("id", submission_id)
  if (rsErr) {
    return NextResponse.json({ error: `Could not confirm: ${rsErr.message}` }, { status: 500 })
  }

  const apply = await applyConfirmedTaxSubmission({
    account_id: sub.account_id,
    tax_year: sub.tax_year,
    actor: `client:${user.id}`,
  })

  return NextResponse.json({ success: true, review_status: "confirmed", apply })
}
