/**
 * The signing steps of the Tax Return pipeline (Tax Return plan, Part 2 item 5, 2026-11-06), by their internal names — ONE list that the
 * e-sign move rules, the client banner, the portal's "is something waiting to be signed" check and the catalog migration share, so a rename can
 * never silently disconnect one of them (stage names are matched EXACTLY; see lib/services/protected-stage-names.ts).
 *
 * The journey after the return is prepared:
 *   Preparation → (staff send the return for signature from the workspace) → Sent for Signature → (the client signs) → Signed →
 *   (staff fax it to the IRS, then "File with IRS") → TR Filed.
 * "TR Completed" is the older "return ready" step; it stays in the pipeline for old jobs and manual moves but no button leads into it any more.
 *
 * Pure and client-safe.
 */
export const TAX_RETURN_SIGN_STAGES = {
  /** the return is being prepared; the prepared file is uploaded here and sent for signature from here */
  preparation: 'Preparation',
  /** the older "return completed" step — still a valid place to send the return for signature from */
  returnCompleted: 'TR Completed',
  /** the document is out with the client */
  sent: 'Sent for Signature',
  /** the client has signed; staff fax the signed return to the IRS and file it */
  signed: 'Signed',
} as const
