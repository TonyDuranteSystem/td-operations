/**
 * Save what staff write next to a client's answers (the DRAFT) on the tax submission. The pure rules are in review-requests.ts.
 *
 * Each pencil saves on its own, as staff type, so two people writing different answers at the same moment must not erase each
 * other: the write re-reads the row and only lands if nobody changed it in between (the submission's updated_at is the guard);
 * otherwise it reads again and re-applies the one change (a few tries). Same idea as the task editor's "changed elsewhere" rule.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { loadTargetTaxSubmission, type TargetSubmissionRow } from "@/lib/tax/target-submission"
import { canWriteReviewRequests, parseReviewRequests, type ReviewRequestsData } from "@/lib/tax/review-requests"

export type SaveDraftResult =
  | { status: "saved"; data: ReviewRequestsData; submissionId: string }
  | { status: "no_submission" | "no_account" }
  | { status: "not_writable"; reviewStatus: string | null }
  | { status: "unknown_answer" }
  | { status: "conflict" }
  | { status: "error"; detail: string }

const MAX_TRIES = 4

/**
 * Apply one change to the draft of the company's target submission.
 * `needsAnswerKey`: the change is a request next to ONE answer — that answer must exist in the submission (a stale pencil is refused).
 */
export async function saveReviewDraftChange(params: {
  accountId: string | null
  needsAnswerKey?: string
  apply: (current: ReviewRequestsData) => ReviewRequestsData
}): Promise<SaveDraftResult> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const loaded = await loadTargetTaxSubmission(params.accountId)
    if (loaded.ok === false) {
      if (loaded.reason === "error") return { status: "error", detail: loaded.detail ?? "could not load the submission" }
      return { status: loaded.reason }
    }
    const sub: TargetSubmissionRow = loaded.sub
    if (!canWriteReviewRequests(sub.review_status)) return { status: "not_writable", reviewStatus: sub.review_status }
    if (params.needsAnswerKey !== undefined) {
      const k = params.needsAnswerKey
      if (!sub.submitted_data || !(k in sub.submitted_data)) return { status: "unknown_answer" }
    }

    const next = params.apply(parseReviewRequests(sub.review_requests))
    // Only the draft may change here: rounds are written by Request Changes alone. Keep the stored rounds exactly as they are.
    const current = parseReviewRequests(sub.review_requests)
    const toStore = { draft: next.draft, rounds: current.rounds }

    const now = new Date().toISOString()
    let upd = supabaseAdmin
      .from("tax_return_submissions")
      .update({ review_requests: toStore as never, updated_at: now })
      .eq("id", sub.id)
    upd = sub.updated_at === null ? upd.is("updated_at", null) : upd.eq("updated_at", sub.updated_at)
    const { data: written, error } = await upd.select("id")
    if (error) return { status: "error", detail: error.message }
    if (written && written.length > 0) return { status: "saved", data: toStore, submissionId: sub.id }
    // somebody else changed the row between our read and our write: read again and re-apply this one change
  }
  return { status: "conflict" }
}
