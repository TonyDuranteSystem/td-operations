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
 * state. It is consulted after review_status — EXCEPT once the return is past the review (see `stageOwnsBanner`) — and before the
 * legacy fallback. Returns null for stages it doesn't own (early/billing stages, unknown names) so the banner degrades to existing
 * behaviour.
 *
 * The REAL Tax Return stages (production pipeline_stages, verified 2026-11-06): Company Data Pending · Paid - Awaiting Data · 1st
 * Installment Paid · Extension Filed · Awaiting 2nd Payment · 2nd Installment Paid · Wizard Available · Data Submitted · Under Review ·
 * Revision Requested · Approved · Confirmed · Data Received · Preparation · TR Completed ("Ready to Sign") · TR Filed · Terminated -
 * Non Payment. The names "Review Completed", "Tax Return Prepared", "Sent for Signature", "Signed", "Filed with IRS", "IRS Receipt
 * Uploaded" and "Completed" are NOT stages of that pipeline (the mapper knew 7 names the pipeline does not have and none of
 * Data Received / Preparation / TR Completed / TR Filed — so a client who had to sign was told "under review"). They stay mapped
 * because other pipelines or older rows may still carry them.
 */

export type FlowBannerState =
  | 'complete_form' // Wizard Available — client must fill the tax wizard
  | 'under_review' // Data Submitted / Under Review — staff reviewing, no client action
  | 'preparing' // Approved / Confirmed / Data Received / Preparation — approved, staff preparing the return
  | 'revision_requested' // Revision Requested — client must edit & resubmit
  | 'sign' // TR Completed — client signs at /portal/sign
  | 'signed' // Signed — signed, awaiting filing
  | 'filed' // TR Filed — filed
  | 'completed' // Completed — done

export function flowStageBannerState(sdStage: string | null | undefined): FlowBannerState | null {
  switch ((sdStage ?? '').trim()) {
    case 'Wizard Available':
      return 'complete_form'
    case 'Data Submitted':
    case 'Under Review':
      return 'under_review'
    case 'Review Completed':
    case 'Approved':
    case 'Confirmed':
    case 'Data Received':
    case 'Preparation':
      return 'preparing'
    case 'Revision Requested':
      return 'revision_requested'
    case 'TR Completed':
    case 'Tax Return Prepared':
    case 'Sent for Signature':
      return 'sign'
    case 'Signed':
      return 'signed'
    case 'TR Filed':
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

/**
 * The state the client's banner shows for a stage. "Sign your tax return" is only true when a document is really waiting for the
 * client's signature: at "TR Completed" the return can be ready on our side with nothing sent yet, and a client told to sign
 * something that is not there is worse than "being prepared". `signatureWaiting` comes from the portal's own list of documents to sign.
 */
export function taxBannerFlowState(sdStage: string | null | undefined, signatureWaiting: boolean): FlowBannerState | null {
  const state = flowStageBannerState(sdStage)
  if (state === 'sign' && !signatureWaiting) return 'preparing'
  return state
}

/** A banner state that belongs to a return already PAST the staff review (preparing, signing, filed, done). */
export function isPostReviewBannerState(state: FlowBannerState | null): boolean {
  return state === 'preparing' || state === 'sign' || state === 'signed' || state === 'filed' || state === 'completed'
}

/**
 * Once a return is past the review, the workspace step decides what the client sees — NOT the old review message from the client's
 * form (which, for "confirmed", used to say "you've confirmed your data" — a button nobody presses any more). Only when the review
 * state asks nothing of the client (none, approved, confirmed) — a return staff re-opened for edits, or sent back for changes,
 * must still show the client its edit message, whatever stage the job sits at.
 */
export function stageOwnsBanner(state: FlowBannerState | null, reviewStatus: string | null | undefined): boolean {
  if (!isPostReviewBannerState(state)) return false
  return reviewStatus == null || reviewStatus === 'approved' || reviewStatus === 'confirmed'
}

/** Whether a banner state carries a client action (link/button) vs. status-only. */
export function flowBannerHasAction(state: FlowBannerState): boolean {
  return state === 'complete_form' || state === 'revision_requested' || state === 'sign'
}

/**
 * Is one of the client's documents-to-sign the tax return itself? The portal lists e-sign envelopes and signature requests by
 * document name ("Tax Return 2025 - Co", "Form 1120 2025 - Co - To Sign", Form 8879, 5472); a lease or an operating agreement waiting
 * for the same client must not turn the tax banner into "sign your tax return".
 */
export function hasTaxReturnToSign(docs: ReadonlyArray<{ type: string; status: string; documentName?: string | null }>): boolean {
  return docs.some(
    (d) => d.type === 'document' && d.status !== 'signed' && /tax return|form\s*(1120|1065|8879|5472)|\b(1120|1065|8879|5472)\b/i.test(d.documentName ?? ''),
  )
}
