/**
 * chain.send_for_signature — STUB at Slice 2.
 *
 * The real implementation needs the body of the signature_request_create MCP
 * tool extracted into a callable helper at lib/operations/signature.ts.
 * That tool (lib/mcp/tools/signature.ts) is ~120 lines of integrated logic:
 * Drive file download, Supabase Storage upload, slug + token generation,
 * primary-contact resolution, signature_requests row insert, and signing-link
 * URL composition. Wrapping it cleanly so both the MCP tool AND this handler
 * use the same code path is a non-trivial refactor that deserves its own
 * design pass.
 *
 * Slice 4 (ITIN) does NOT need this handler — the ITIN forms are mailed
 * physically, not e-signed. Slice 8 (Lease) is the first workflow that will
 * exercise signature requests; the extraction can happen as part of Slice 8
 * preparation or as a dedicated dev_task before then.
 *
 * Until extraction lands, any workflow referencing this handler receives a
 * clean failure from the dispatcher with the audit row marked NOT_IMPLEMENTED.
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor.
 *  STUB at Slice 2; schema will be filled when the real handler ships. */
export { chainSendForSignatureParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainSendForSignature: WorkflowHandler = async (
  _ctx: HandlerContext,
): Promise<HandlerResult> => {
  return {
    success: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message:
        "chain.send_for_signature is a Slice 2 stub. Implementation requires extracting signature_request_create logic into lib/operations/signature.ts. Not needed for Slice 4 ITIN workflow.",
    },
    side_effects: [],
  }
}
