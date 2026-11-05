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
