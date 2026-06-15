/**
 * Flow-stage → portal tax-banner state.
 *
 * The portal tax banner (`components/portal/tax-banner.tsx`) is driven first by
 * the production `tax_return_submissions.review_status` sub-state machine. Flow-
 * workspace Tax Returns advance through REAL service_delivery stages and often
 * have NO review_status, so without this they fall through to the legacy
 * "Edit submission" banner regardless of where the SD actually is.
 *
 * This pure mapper classifies the SD's flow stage into a client-facing banner
 * state. It is consulted ONLY after review_status (so production clients with a
 * review_status are never affected) and before the legacy fallback. Returns null
 * for stages it doesn't own (early/billing stages, unknown names) so the banner
 * degrades to existing behaviour.
 */

export type FlowBannerState =
  | 'complete_form' // Wizard Available — client must fill the tax wizard
  | 'under_review' // Data Submitted / Under Review — staff reviewing, no client action
  | 'preparing' // Review Completed — approved, staff preparing the return
  | 'revision_requested' // Revision Requested — client must edit & resubmit
  | 'sign' // Tax Return Prepared / Sent for Signature — client signs at /portal/sign
  | 'signed' // Signed — signed, awaiting filing
  | 'filed' // Filed with IRS / IRS Receipt Uploaded — filed
  | 'completed' // Completed — done

export function flowStageBannerState(sdStage: string | null | undefined): FlowBannerState | null {
  switch ((sdStage ?? '').trim()) {
    case 'Wizard Available':
      return 'complete_form'
    case 'Data Submitted':
    case 'Under Review':
      return 'under_review'
    case 'Review Completed':
      return 'preparing'
    case 'Revision Requested':
      return 'revision_requested'
    case 'Tax Return Prepared':
    case 'Sent for Signature':
      return 'sign'
    case 'Signed':
      return 'signed'
    case 'Filed with IRS':
    case 'IRS Receipt Uploaded':
      return 'filed'
    case 'Completed':
      return 'completed'
    default:
      // Early/billing stages (Extension Due, Awaiting 2nd Payment, …) and any
      // unknown name fall through to the banner's existing logic.
      return null
  }
}

/** Whether a banner state carries a client action (link/button) vs. status-only. */
export function flowBannerHasAction(state: FlowBannerState): boolean {
  return state === 'complete_form' || state === 'revision_requested' || state === 'sign'
}
