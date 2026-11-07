/**
 * GET  /api/crm/tax-review/action?submission_id=... — current review_status (Slice 4).
 * POST /api/crm/tax-review/action — staff review actions (Slice 2 piece 4).
 *
 * Staff-only. Drives the review state machine from the staff side. The What's
 * New card buttons (Slice 4 UI) post here.
 *
 *   start_review     submitted | resubmitted → under_review
 *   approve          under_review (also submitted / resubmitted / approved) → confirmed — approval RELEASES the submission;
 *                    the client is NOT asked to confirm (that step was removed 2026-11-06). Shared with the workspace's Approve
 *                    button: lib/tax/approve-submission.ts.
 *   request_changes  under_review            → revision_requested  (note required)
 *   reopen           confirmed               → reopened      (unlocks for edits)
 *
 * Each action appends a review_history round. request_changes/reopen also send
 * the client a portal-chat notice and resolve the open What's New card so a
 * later re-submission raises a fresh one.
 *
 * Body: { submission_id: string, action: Action, note?: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { canTransition, buildReviewHistoryEntry, type ReviewStatus } from "@/lib/tax/review-status"
import { approveTaxSubmission } from "@/lib/tax/approve-submission"

type Action = "start_review" | "approve" | "request_changes" | "reopen"

const ACTION_TARGET: Record<Action, ReviewStatus> = {
  start_review: "under_review",
  approve: "confirmed", // handled by approveTaxSubmission below (release), never by the generic path
  request_changes: "revision_requested",
  reopen: "reopened",
}

function clientNotice(action: Action, note: string | undefined): string | null {
  switch (action) {
    case "request_changes":
      return `Our team reviewed your tax submission and needs a change: ${note}\n\nPlease open the portal, edit your tax information, and resubmit.`
    case "reopen":
      return `We've reopened your tax submission so you can make edits. Please review and resubmit when ready.`
    default:
      return null
  }
}

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })

  const submissionId = req.nextUrl.searchParams.get("submission_id")
  if (!submissionId) return NextResponse.json({ error: "submission_id required" }, { status: 400 })

  const { data: sub, error } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, review_status")
    .eq("id", submissionId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!sub) return NextResponse.json({ error: "Submission not found" }, { status: 404 })

  return NextResponse.json({ submission_id: sub.id, review_status: sub.review_status })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const { submission_id, action, note } = body as { submission_id?: string; action?: Action; note?: string }

  if (!submission_id || !action || !(action in ACTION_TARGET)) {
    return NextResponse.json({ error: "submission_id and a valid action are required" }, { status: 400 })
  }
  if (action === "request_changes" && !note?.trim()) {
    return NextResponse.json({ error: "A note is required when requesting changes." }, { status: 400 })
  }

  // Approve = release (the client's Confirm step was removed, 2026-11-06). One shared helper, also used by the workspace's Approve button.
  if (action === "approve") {
    const result = await approveTaxSubmission({ submissionId: submission_id, by: getUserDisplayName(user) })
    switch (result.status) {
      case "approved":
      case "already_released":
        return NextResponse.json({
          success: true,
          review_status: "confirmed",
          already_released: result.status === "already_released",
          apply: result.apply ?? null,
          client_notified: null,
        })
      case "no_submission":
        return NextResponse.json({ error: "Submission not found" }, { status: 404 })
      case "conflict":
        return NextResponse.json(
          { error: "This submission was just changed by someone else — refresh and try again.", review_status: result.from ?? null },
          { status: 409 },
        )
      case "not_in_review":
      case "not_approvable":
        return NextResponse.json(
          { error: `Cannot approve from "${result.from ?? "(none)"}".`, review_status: result.from ?? null },
          { status: 409 },
        )
      default:
        return NextResponse.json({ error: `Could not approve: ${result.detail ?? result.status}` }, { status: 500 })
    }
  }

  const target = ACTION_TARGET[action]

  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, account_id, contact_id, review_status, review_history")
    .eq("id", submission_id)
    .single()
  if (!sub) return NextResponse.json({ error: "Submission not found" }, { status: 404 })

  const prev = (sub.review_status ?? null) as ReviewStatus | null
  if (!canTransition(prev, target)) {
    return NextResponse.json(
      { error: `Cannot ${action} from "${prev ?? "(none)"}".`, review_status: prev },
      { status: 409 },
    )
  }

  const now = new Date().toISOString()
  const by = getUserDisplayName(user)
  const reviewHistory = Array.isArray(sub.review_history) ? sub.review_history : []
  reviewHistory.push(
    buildReviewHistoryEntry({
      from: prev,
      to: target,
      at: now,
      by,
      note: action === "request_changes" ? note : undefined,
    }),
  )

  const { error: rsErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .update({ review_status: target, review_history: reviewHistory, updated_at: now })
    .eq("id", submission_id)
  if (rsErr) {
    return NextResponse.json({ error: `Could not update review: ${rsErr.message}` }, { status: 500 })
  }

  // Resolve the open What's New card on terminal-for-this-round actions so a
  // re-submission raises a fresh one (emitActionNeeded skips while one is open).
  if (action === "request_changes" || action === "reopen") {
    await supabaseAdmin
      .from("message_actions")
      .update({ resolved_at: now })
      .eq("source_ref", `tax_submission:${submission_id}`)
      .is("resolved_at", null)
  }

  // Client-facing notice. request_changes BLOCKS the review loop on a client
  // action (edit+resubmit), so it dispatches the full action-required package
  // (clickable chat + immediate email + bell/push, Phase C 2026-07-02 — was
  // chat-only, silent unless the client happened to open the portal). reopen
  // keeps the original chat-only notice. (approve never gets here: it asks
  // nothing of the client any more.)
  let clientNotified: unknown = null
  if (sub.account_id && action === "request_changes") {
    const { notifyClientActionRequired } = await import("@/lib/portal/action-required")
    const staffNote = note?.trim() ?? ""
    const dispatch = await notifyClientActionRequired({
      account_id: sub.account_id,
      contact_id: (sub.contact_id as string | null) ?? null,
      title: { en: "Changes needed on your tax submission", it: "Modifiche richieste alla tua dichiarazione" },
      message: {
        en: `Our team reviewed your tax submission and needs a change: ${staffNote}\n\nPlease open your portal, edit your tax information, and resubmit.`,
        it: `Il nostro team ha revisionato la tua dichiarazione e serve una modifica: ${staffNote}\n\nAccedi al portale, correggi le informazioni fiscali e reinvia.`,
      },
      link: "/portal",
    })
    clientNotified = dispatch
  } else {
    // reopen (and any future informational action): original chat-only notice.
    // sender_id uses the zero-UUID system placeholder — portal_messages.sender_id
    // is NOT NULL; see lib/portal/chat-events.ts for the established convention.
    const notice = clientNotice(action, note)
    if (notice && sub.account_id) {
      const { error: msgErr } = await supabaseAdmin.from("portal_messages").insert({
        account_id: sub.account_id,
        sender_type: "system",
        sender_id: "00000000-0000-0000-0000-000000000000",
        message: notice,
      })
      if (msgErr) console.error("[tax-review] portal_messages insert failed:", msgErr.message)
    }
  }

  return NextResponse.json({ success: true, review_status: target, client_notified: clientNotified })
}
