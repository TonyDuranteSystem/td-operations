/**
 * Pure decision for the staff What's New note posted when a client submits
 * the Company Closure form (app/api/closure-form-completed/route.ts, step 5b —
 * Antonio, 2026-09-24). Kept out of the route file (Next.js route modules may
 * only export handlers) so every branch is unit-tested.
 *
 *  - skip:        step 3 just auto-created the closure SD, so createSD's own
 *                 workflow_spawned note already announces this same event.
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
  dedupeKey: string | null | undefined
  priorHash: string | null | undefined
  isGenuineChange: boolean
}): ClosureWhatsNewDecision {
  if (params.sdWasNewlyCreated) return { action: "skip", retireFirst: false, isResubmission: false }
  const isResubmission = !!params.dedupeKey && !!params.priorHash && params.isGenuineChange
  return { action: "emit", retireFirst: isResubmission, isResubmission }
}
