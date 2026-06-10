/**
 * Shared Tax Return stage overlay (Slices 5 + 6).
 *
 * A Tax Return service delivery PARKS at "Data Submitted" (stage 45) for the
 * entire review loop — the fine-grained position lives on
 * `tax_return_submissions.review_status`. The catalog stages 46-49 (Under
 * Review / Revision Requested / Approved / Confirmed) exist to REPRESENT those
 * sub-states on both the client progress tracker (Slice 5) and the staff Tax
 * Board (Slice 6).
 *
 * Both surfaces compute the same "effective stage": the FURTHER of the SD's
 * own stage and the stage mapped from review_status — so a stale review_status
 * can never drag an already-advanced SD backwards, and a submission under
 * review shows in its review column instead of piling into "Data Submitted".
 *
 * This map is the single source of truth for that overlay. Keep it here, not
 * duplicated in each surface.
 */

/** review_status → catalog stage_name it represents on the board/tracker. */
export const REVIEW_STATUS_STAGE: Record<string, string> = {
  submitted: 'Data Submitted',
  resubmitted: 'Data Submitted',
  reopened: 'Data Submitted',
  under_review: 'Under Review',
  revision_requested: 'Revision Requested',
  approved: 'Approved',
  confirmed: 'Confirmed',
}

/** Minimal catalog shape the overlay needs: a name + an order to compare. */
export interface StageOrderRef {
  stage_name: string
  stage_order: number
}

/**
 * Resolve the effective stage_name for a card/tracker given its SD stage and
 * review_status. Returns the further of (SD stage, mapped review stage) by
 * stage_order. Falls back to the SD stage name when either side is unknown to
 * the catalog (defensive — never invents a stage).
 */
export function overlayEffectiveStageName(
  catalogStages: StageOrderRef[],
  sdStageName: string | null,
  reviewStatus?: string | null,
): string | null {
  if (!sdStageName) return null
  const sdStage = catalogStages.find(s => s.stage_name === sdStageName)

  const mappedName = reviewStatus ? REVIEW_STATUS_STAGE[reviewStatus] : undefined
  if (!mappedName) return sdStageName

  const mapped = catalogStages.find(s => s.stage_name === mappedName)
  if (!mapped) return sdStageName
  // SD stage unknown to the catalog but review stage is known → trust the
  // review overlay (the submission is genuinely in that sub-state).
  if (!sdStage) return mapped.stage_name

  return mapped.stage_order > sdStage.stage_order ? mapped.stage_name : sdStageName
}
