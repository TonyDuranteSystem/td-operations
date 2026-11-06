/**
 * "This step needs the IRS tracking number saved before the job moves on" — the data-driven rule (Company Closure workspace, Antonio 2026-11-05:
 * after we ship the EIN closure letter we write the tracking number, and the next step stays locked until it is saved).
 *
 * The step's own screen says so: an `irs_tracking_entry` box with `requiredToAdvance: true` in `pipeline_stages.stage_layout`. Pure — no database —
 * so advanceServiceDelivery (lib/service-delivery.ts, step 4c) and the tests use the very same check. ITIN keeps its older hard-coded rule for
 * "Submitted to IRS" next to it (unchanged); a new service only needs the one line in its layout.
 */
import { parseStageLayout } from '@/lib/flows/stage-layout'

/** Does this step's screen insist on a saved tracking number before the job moves FORWARD? Unreadable or missing layout = no. */
export function trackingRequiredToAdvance(stageLayout: unknown): boolean {
  const layout = parseStageLayout(stageLayout)
  return (layout?.components ?? []).some((c) => c.type === 'irs_tracking_entry' && c.requiredToAdvance === true)
}

/** The refusal shown when the number is missing (same words as the older ITIN rule, so staff see one sentence everywhere). */
export function trackingMissingMessage(targetStageName: string): string {
  return `Enter the IRS mailing tracking number before moving this case to "${targetStageName}".`
}

interface TrackingStepLike {
  stage_name: string
  stage_order: number
  stage_layout?: unknown
}

/**
 * The steps a FORWARD move from `fromOrder` to `toOrder` leaves or jumps over whose screen insists on a saved tracking number — the same range the
 * "needs a document" rule uses (from <= step < to), so a shortcut over the step (the step bar, a tool asking for a later step, the automatic
 * move when a step's to-dos are done) cannot skip the lock (bug-hunter 2026-11-05). Going back, staying, or an unknown step crosses nothing.
 */
export function trackingStepsCrossed(
  steps: TrackingStepLike[],
  fromOrder: number | null | undefined,
  toOrder: number | null | undefined,
): string[] {
  if (typeof fromOrder !== 'number' || typeof toOrder !== 'number' || toOrder <= fromOrder) return []
  return steps
    .filter((s) => s.stage_order >= fromOrder && s.stage_order < toOrder && trackingRequiredToAdvance(s.stage_layout))
    .sort((a, b) => a.stage_order - b.stage_order)
    .map((s) => s.stage_name)
}
