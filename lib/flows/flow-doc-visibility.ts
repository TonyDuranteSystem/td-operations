/**
 * Curated client-visibility policy for flow-stamped documents (Service Flow
 * Workspaces, client portal side).
 *
 * Flow documents are uploaded by staff in the workspace and stamped with
 * `service_delivery_id` + `flow_stage`. They are written `portal_visible=false`
 * by default — some are INTERNAL working drafts the client must NOT see (most
 * importantly the UNSIGNED prepared return at the "Tax Return Prepared" stage).
 *
 * Per Antonio's decision (2026-06-14): the portal shows flow docs from a CURATED
 * ALLOWLIST of client-safe stages (receipts / confirmations / signed outputs),
 * NOT every flow doc. This is the single curation point — add a stage here to
 * expose its documents to the client. Anything not listed stays internal.
 *
 * `flow_stage` records the stage the SD was AT when the document was uploaded
 * (i.e. before any auto-advance), so the allowlist is keyed on those pre-advance
 * stage names. A document that is already `portal_visible=true` is always shown
 * (an admin explicitly published it) regardless of stage.
 */

/** Per service_type, the flow_stage values whose documents are client-facing. */
export const CLIENT_SAFE_FLOW_DOC_STAGES: Record<string, ReadonlySet<string>> = {
  'State Annual Report': new Set([
    'Due Date', // the filed annual report
    'Filed',
    'Filing Receipt Uploaded', // filing receipt / confirmation
  ]),
  'State RA Renewal': new Set([
    'Renewal Due',
    'Renewal Processed',
    'Document Uploaded', // renewal confirmation document
  ]),
  'Tax Return': new Set([
    'Extension Due', // extension confirmation/receipt
    'Filed with IRS', // IRS transmission receipt
    'IRS Receipt Uploaded',
    'Signed', // the signed return
    'Completed',
    // NOTE: 'Tax Return Prepared' is intentionally EXCLUDED — that is the
    // unsigned draft return. The client receives the signed copy via the
    // e-signature flow, never the raw prepared draft.
  ]),
  'CMRA Mailing Address': new Set([
    'Lease Signed',
    'CMRA Active',
  ]),
}

/**
 * Whether a flow-stamped document should be shown to the client.
 *
 * - Already published (`portal_visible=true`) → always shown.
 * - Otherwise shown only when its `flow_stage` is in the curated client-safe
 *   allowlist for its `service_type`.
 *
 * Pure. Unknown service types / stages and a null flow_stage → not shown
 * (fail-closed: never leak an unrecognised internal document).
 */
export function isClientSafeFlowDoc(
  serviceType: string | null | undefined,
  flowStage: string | null | undefined,
  portalVisible: boolean | null | undefined,
): boolean {
  if (portalVisible === true) return true
  if (!serviceType || !flowStage) return false
  return CLIENT_SAFE_FLOW_DOC_STAGES[serviceType]?.has(flowStage) ?? false
}
