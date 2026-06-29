/**
 * Pure helpers for the client-facing Company Formation progress tracker.
 *
 * The tracker reads the formation service_delivery's CURRENT stage + the
 * Company Formation `pipeline_stages` (client_label / client_label_it) — a single
 * source of truth — instead of stitching together separate signals
 * (wizard status, account.filing_id, ss4 status, …). Stage labels are catalog-
 * driven, so relabels need no deploy.
 *
 * Two stages are CLIENT-ACTION stages: while the formation sits at one of them,
 * the client must do something to move forward, so the tracker glows amber with
 * an "Action required" link:
 *   - "Payment Confirmed" → the client must complete the formation wizard.
 *   - "SS-4 Prepared"     → the client must sign the SS-4.
 */

export interface FormationStageRow {
  stage_name: string
  stage_order: number
  client_label: string | null
  client_label_it: string | null
}

export type FormationStepStatus = 'completed' | 'current' | 'upcoming'
export type FormationClientAction = 'wizard' | 'sign'

export interface FormationTrackerStep {
  stageName: string
  label: string
  status: FormationStepStatus
  /** The client action this stage needs, if any. */
  action?: FormationClientAction
  /** True when this is a client-action stage AND it's the current stage. */
  isActionRequired: boolean
  /**
   * ISO timestamp of when the formation was filed with the state — set ONLY on
   * the "Filed with State" step, and only once that step is reached
   * (status completed or current). The renderer appends "· Filed <date>" to the
   * label. Null/absent when unknown (legacy SDs with no recorded filing
   * transition) or for every other step.
   */
  filedAt?: string | null
  /**
   * ISO timestamp of when the SS-4 fax receipt was uploaded (SD advanced to
   * "SS-4 Sent to IRS") — set ONLY on that step, once reached. The renderer
   * appends "· Faxed <date>" to the label. Null/absent when unknown or for
   * every other step.
   */
  faxedAt?: string | null
}

/** The stage whose label carries the "· Filed <date>" suffix. */
const FILED_STAGE = 'Filed with State'

/** The stage whose label carries the "· Faxed <date>" suffix. */
const FAX_STAGE = 'SS-4 Sent to IRS'

/** Stage name → the client action required while sitting at that stage. */
const ACTION_STAGES: Record<string, FormationClientAction> = {
  'Payment Confirmed': 'wizard',
  'SS-4 Prepared': 'sign',
}

function labelFor(stage: FormationStageRow, locale: 'en' | 'it'): string {
  if (locale === 'it') return stage.client_label_it || stage.client_label || stage.stage_name
  return stage.client_label || stage.stage_name
}

/**
 * Build the ordered tracker steps from the Company Formation pipeline stages and
 * the formation SD's current stage. Stages are sorted by stage_order. Steps
 * before the current stage are completed, the matching stage is current, the
 * rest upcoming. If currentStage is unknown/null, nothing is marked current.
 */
export function buildFormationTrackerSteps(
  stages: FormationStageRow[],
  currentStage: string | null | undefined,
  locale: 'en' | 'it',
  filedAt?: string | null,
  faxedAt?: string | null,
): FormationTrackerStep[] {
  const ordered = [...stages].sort((a, b) => a.stage_order - b.stage_order)
  const currentRow = currentStage
    ? ordered.find((s) => s.stage_name === currentStage) ?? null
    : null
  const currentOrder = currentRow?.stage_order ?? -1

  return ordered.map((s) => {
    let status: FormationStepStatus
    if (currentOrder < 0) status = 'upcoming'
    else if (s.stage_order < currentOrder) status = 'completed'
    else if (s.stage_order === currentOrder) status = 'current'
    else status = 'upcoming'

    const action = ACTION_STAGES[s.stage_name]
    return {
      stageName: s.stage_name,
      label: labelFor(s, locale),
      status,
      action,
      isActionRequired: status === 'current' && action != null,
      // Carry the filing date only on the Filed-with-State step, and only once
      // it's reached (completed/current) — an upcoming step shows no date.
      ...(s.stage_name === FILED_STAGE && filedAt && status !== 'upcoming'
        ? { filedAt }
        : {}),
      // Carry the fax date only on the SS-4 Sent to IRS step, once reached.
      ...(s.stage_name === FAX_STAGE && faxedAt && status !== 'upcoming'
        ? { faxedAt }
        : {}),
    }
  })
}
