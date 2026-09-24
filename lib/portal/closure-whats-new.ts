/**
 * Pure decision for the staff What's New note posted when a client submits
 * the Company Closure form (app/api/closure-form-completed/route.ts, step 5b —
 * Antonio, 2026-09-24). Kept out of the route file (Next.js route modules may
 * only export handlers) so every branch is unit-tested.
 *
 *  - skip:        step 3 just auto-created the closure SD, so createSD's own
 *                 workflow_spawned note already announces this same event —
 *                 or this is a REPLAY (retry) of the submission that created
 *                 it. A genuine correction of that same submission is NOT
 *                 skipped (council round 3: it would create a staff task
 *                 with no What's New note).
 *  - resubmission: the row was processed before (a prior content hash exists)
 *                 AND this content differs → retire the old note, post a
 *                 fresh "resubmitted" one.
 *  - otherwise:   plain emit. A mechanical retry of identical content lands
 *                 here too and is made a no-op by the marker dedup.
 *  No dedupe key (legacy emailed-link flow) is never treated as a
 *  resubmission — there is no way to tell a correction from a replay.
 */
export interface ClosureWhatsNewDecision {
  action: "skip" | "emit"
  retireFirst: boolean
  isResubmission: boolean
}

export function decideClosureWhatsNew(params: {
  sdWasNewlyCreated: boolean
  /** The existing SD was created FROM this very submission (source_closure_token). */
  sdCreatedFromThisSubmission?: boolean
  dedupeKey: string | null | undefined
  priorHash: string | null | undefined
  isGenuineChange: boolean
}): ClosureWhatsNewDecision {
  const isResubmission = !!params.dedupeKey && !!params.priorHash && params.isGenuineChange
  if (params.sdWasNewlyCreated) return { action: "skip", retireFirst: false, isResubmission: false }
  if (params.sdCreatedFromThisSubmission && !isResubmission) {
    return { action: "skip", retireFirst: false, isResubmission: false }
  }
  return { action: "emit", retireFirst: isResubmission, isResubmission }
}

/**
 * Should a "resubmission note swallowed" system error be reported? True only
 * when this pass wanted to replace the old note (retireFirst), retired nothing,
 * and the emit was deduped against a note that PREDATES this pass. If the
 * surviving note was posted after this pass started, a concurrent pass (e.g. an
 * overlapping job retry) already retired the old note and posted the fresh one
 * — staff were alerted, so reporting would be a false alarm (council round 3).
 * An unknown note timestamp is treated as "predates" → report (fail loud).
 */
export function shouldReportSwallowedResubmission(params: {
  retireFirst: boolean
  retiredCount: number
  emitReason: string | null | undefined
  survivingNoteCreatedAt: string | null | undefined
  passStartedAt: Date
}): boolean {
  if (!params.retireFirst || params.retiredCount > 0 || params.emitReason !== "already_emitted") return false
  const noteTime = params.survivingNoteCreatedAt ? new Date(params.survivingNoteCreatedAt).getTime() : NaN
  if (!Number.isFinite(noteTime)) return true
  return noteTime < params.passStartedAt.getTime()
}
