/**
 * Tax Submission Review — state machine (Slice 2).
 *
 * Pure, side-effect-free rules for `tax_return_submissions.review_status`.
 * The routes/handlers own the DB writes + notifications; this module only
 * answers "is this transition legal?", "what does it mean?", and builds the
 * `review_history` round entry. Keeping it pure makes the workflow fully
 * unit-testable without a DB.
 *
 * State machine (spec REV 3.1 §3):
 *
 *   (initial) → submitted → under_review → approved → confirmed
 *                              ↓                          ↓
 *                       revision_requested            reopened → submitted
 *                              ↓
 *                         resubmitted → under_review
 *
 * Macro lifecycle lives on the SD `stage` ("Data Submitted" for the whole
 * review); `review_status` is the fine sub-state. Only `confirmed` advances
 * the SD past the review block (→ Data Received). Decision 2026-06-09.
 */

import type { Json } from "@/lib/database.types"

export const REVIEW_STATUSES = [
  "submitted",
  "under_review",
  "revision_requested",
  "resubmitted",
  "approved",
  "confirmed",
  "reopened",
] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export function isReviewStatus(v: unknown): v is ReviewStatus {
  return typeof v === "string" && (REVIEW_STATUSES as readonly string[]).includes(v)
}

/**
 * Allowed forward transitions. The key `null` is the initial submit (no prior
 * review_status yet). `reopened` immediately re-enters the loop at `submitted`.
 */
export const REVIEW_TRANSITIONS: Record<ReviewStatus | "null", ReviewStatus[]> = {
  // `null → revision_requested` + `submitted/resubmitted/reopened → revision_requested`
  // added 2026-07-23 (Carasso edit-button fix): staff pressing "Request Changes"
  // in the flow workspace is a genuine review action that must open the client's
  // edit, and it has to work on submissions that never entered the review loop.
  // The ~64 legacy external-form submissions carry review_status = null (they set
  // the old `status='reviewed'`, never a review_status), so the ONLY lawful entry
  // used to be `null → submitted`, which no button drove. "Request changes" is
  // legal from every non-confirmed state; confirmed still routes through reopened.
  null: ["submitted", "revision_requested"],
  submitted: ["under_review", "revision_requested"],
  under_review: ["approved", "revision_requested"],
  revision_requested: ["resubmitted"],
  resubmitted: ["under_review", "revision_requested"],
  // approved → submitted: a client EDIT invalidates the approval (added
  // 2026-07-16, PTBT fix — closes the approve-then-swap window where edited
  // data could be confirmed unreviewed). The submit route performs this
  // transition synchronously.
  approved: ["confirmed", "revision_requested", "submitted"],
  confirmed: ["reopened"],
  reopened: ["submitted", "revision_requested"],
}

/** Who legitimately drives each transition (used for the history entry + route auth). */
export const TRANSITION_ACTOR: Record<ReviewStatus, "client" | "staff"> = {
  submitted: "client",
  under_review: "staff",
  revision_requested: "staff",
  resubmitted: "client",
  approved: "staff",
  confirmed: "client",
  reopened: "staff",
}

/** Is `to` a legal next status from `from` (null = first submit)? */
export function canTransition(from: ReviewStatus | null, to: ReviewStatus): boolean {
  const key = (from ?? "null") as ReviewStatus | "null"
  return REVIEW_TRANSITIONS[key]?.includes(to) ?? false
}

/**
 * Statuses where the client may still edit/resubmit their data (spec §5 banner:
 * Edit button shown at submitted / revision_requested / approved). `under_review`
 * (staff actively reviewing) and `confirmed` (locked, read-only) are NOT editable.
 */
const CLIENT_EDITABLE = new Set<ReviewStatus>(["submitted", "revision_requested", "approved", "reopened"])

/** Replaces the old `sent_to_accountant` wizard lock: locked = NOT editable. */
export function isClientEditable(status: ReviewStatus | null): boolean {
  if (status === null) return true
  return CLIENT_EDITABLE.has(status)
}

/** Only `confirmed` releases the SD from the review block (→ Data Received). */
export function advancesServiceDelivery(status: ReviewStatus): boolean {
  return status === "confirmed"
}

export interface ReviewHistoryEntry {
  from: ReviewStatus | null
  to: ReviewStatus
  at: string
  by: string
  actor: "client" | "staff"
  note?: string
  // jsonb-bound: every field above is JSON-serializable, so this index signature
  // makes the entry assignable to a `Json` column (review_history) without per-site casts.
  [key: string]: Json | undefined
}

/** Build one immutable round entry to append to `review_history`. */
export function buildReviewHistoryEntry(params: {
  from: ReviewStatus | null
  to: ReviewStatus
  at: string
  by: string
  note?: string
}): ReviewHistoryEntry {
  const entry: ReviewHistoryEntry = {
    from: params.from,
    to: params.to,
    at: params.at,
    by: params.by,
    actor: TRANSITION_ACTOR[params.to],
  }
  if (params.note && params.note.trim()) entry.note = params.note.trim()
  return entry
}
