/**
 * chain.upload_document — STUB at Slice 2.
 *
 * The real implementation needs:
 *   - A canonical `lib/operations/document.ts::insertDocument` helper (the
 *     existing file only exposes update helpers).
 *   - Composition with lib/google-drive.ts uploadBinaryToDrive / uploadFile.
 *   - Decision on which `kind` enum values the workflow can emit.
 *   - Drive trash rollback path.
 *
 * Implementing this in Slice 2 would require either (a) substantial extraction
 * from existing inline insert sites (formation-materialize.ts, etc.) into a
 * helper, or (b) routing a raw insert with eslint-disable through the workflow
 * handler — both of which deserve their own design pass. Slice 4 (ITIN
 * workflow) does NOT need this handler — itin.approve_and_send composes
 * chain.send_email + chain.send_client_message + chain.advance_sd_stage and
 * the PDFs are already uploaded to Drive by the upstream ITIN auto-chain.
 *
 * Tracking: a follow-up dev_task should be opened to extract document
 * operations into lib/operations/document.ts and wire this handler. Until
 * then, any workflow row referencing this handler will receive a clean
 * 501-style failure from the dispatcher.
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor.
 *  STUB at Slice 2; schema will be filled when the real handler ships. */
export { chainUploadDocumentParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainUploadDocument: WorkflowHandler = async (
  _ctx: HandlerContext,
): Promise<HandlerResult> => {
  return {
    success: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message:
        "chain.upload_document is a Slice 2 stub. Implementation requires lib/operations/document.ts::insertDocument helper extraction. Not needed for Slice 4 ITIN workflow.",
    },
    side_effects: [],
  }
}
