/**
 * Flow-workspace "Request Changes" → review-state write (Carasso edit-button
 * fix, 2026-07-23).
 *
 * PROBLEM this closes: the flow-workspace "Request Changes" button only advanced
 * the service-delivery STAGE to "Revision Requested"; it never wrote the
 * submission's `review_status`. The portal decides whether the client may edit
 * from `review_status`, not from the SD stage — so the banner told the client to
 * edit while the gate refused him. Legacy external-form submissions sit at
 * `review_status = null` and NO button drove them into an editable state.
 *
 * This pure decision core answers "given the submission's current review_status,
 * should pressing Request Changes write revision_requested, and from what?".
 * The route owns the DB write + client notification; keeping the rule here makes
 * it unit-testable without a DB and keeps it identical to the What's New route's
 * state machine (both go through `canTransition`).
 */

import { canTransition, type ReviewStatus } from "@/lib/tax/review-status"

export type FlowRevisionReason =
  | "already_revision_requested"
  | "confirmed_locked"
  | "no_submission"
  | "illegal"

export interface FlowRevisionDecision {
  ok: boolean
  /** Present when ok: the prior review_status the write transitions from. */
  from?: ReviewStatus | null
  /** Present when ok. */
  to?: "revision_requested"
  /** Present when NOT ok: why the write was skipped. */
  reason?: FlowRevisionReason
}

/**
 * Decide the review-state write for a flow-workspace Request Changes press.
 *  - no submission row               → no_submission (nothing to unlock)
 *  - already revision_requested      → idempotent no-op (a second press is safe)
 *  - confirmed                       → confirmed_locked (must be reopened first,
 *                                      the deliberate finalized-return guard)
 *  - any other non-confirmed state   → revision_requested, iff canTransition agrees
 */
export function decideFlowRevision(
  current: ReviewStatus | null,
  hasSubmission: boolean,
): FlowRevisionDecision {
  if (!hasSubmission) return { ok: false, reason: "no_submission" }
  if (current === "revision_requested") return { ok: false, reason: "already_revision_requested" }
  if (current === "confirmed") return { ok: false, reason: "confirmed_locked" }
  if (!canTransition(current, "revision_requested")) return { ok: false, reason: "illegal" }
  return { ok: true, from: current, to: "revision_requested" }
}
