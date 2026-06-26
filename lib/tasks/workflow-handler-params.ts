/**
 * Workflow Handler Param-Schema Registry — maps action.handler slugs to the
 * Zod schema describing each handler's `handler_params` shape (the catalog-
 * configurable parameters set at workflow-definition time, distinct from
 * `ctx.params` which is the operator's runtime input).
 *
 * Parallel to `lib/tasks/workflow-registry.ts` (which maps slugs to handler
 * functions). Imports schemas from `handler-param-schemas.ts` — a pure-Zod
 * file with no server deps so the editor (client component) can import this
 * registry without dragging server-only modules into the browser bundle.
 *
 * Adding a new handler: (1) write the handler in
 * `lib/tasks/workflow-handlers/<slug>.ts` (server side). (2) Define its
 * param schema in `lib/tasks/handler-param-schemas.ts`. (3) Re-export the
 * schema from the handler file as `handlerParamsSchema`. (4) Register the
 * handler function in `workflow-registry.ts`. (5) Register the schema
 * here. The editor picks up the new handler automatically and renders its
 * params form.
 */

import type { ZodTypeAny } from "zod"

import {
  taskCancelParams,
  taskFlagBlockedParams,
  taskReassignParams,
  taskSnoozeParams,
  taskWaitingParams,
  chainAdvanceSdStageParams,
  chainSpawnNextWorkflowParams,
  chainSendClientMessageParams,
  chainSendEmailParams,
  chainSendForSignatureParams,
  chainAwaitClientActionParams,
  chainUploadDocumentParams,
  chainUpdateContactFieldParams,
  chainUpdateAccountFieldParams,
  itinConfirmNumberReceivedParams,
  bankingApproveFormParams,
  taxApproveAndApplyParams,
  closureApproveDataParams,
  formationConfirmEinReceivedParams,
  sdMarkCompleteParams,
} from "./handler-param-schemas"

const HANDLER_PARAM_SCHEMAS: Record<string, ZodTypeAny> = {
  "task.flag_blocked": taskFlagBlockedParams,
  "task.waiting_with_optional_message": taskWaitingParams,
  "task.snooze": taskSnoozeParams,
  "task.reassign": taskReassignParams,
  "task.cancel": taskCancelParams,

  "chain.advance_sd_stage": chainAdvanceSdStageParams,
  "chain.spawn_next_workflow": chainSpawnNextWorkflowParams,
  "chain.send_client_message": chainSendClientMessageParams,
  "chain.send_email": chainSendEmailParams,
  "chain.send_for_signature": chainSendForSignatureParams,
  "chain.await_client_action": chainAwaitClientActionParams,
  "chain.upload_document": chainUploadDocumentParams,
  "chain.update_contact_field": chainUpdateContactFieldParams,
  "chain.update_account_field": chainUpdateAccountFieldParams,

  "itin.confirm_number_received": itinConfirmNumberReceivedParams,

  "banking.approve_form": bankingApproveFormParams,
  "tax.approve_and_apply": taxApproveAndApplyParams,

  "closure.approve_data": closureApproveDataParams,
  "formation.confirm_ein_received": formationConfirmEinReceivedParams,
  "sd.mark_complete": sdMarkCompleteParams,
}

/** Look up a handler's catalog-params schema by slug. */
export function getHandlerParamSchema(slug: string): ZodTypeAny | null {
  return HANDLER_PARAM_SCHEMAS[slug] ?? null
}

/** All registered handler slugs that have a param schema. */
export function getRegisteredHandlerParamSchemaSlugs(): string[] {
  return Object.keys(HANDLER_PARAM_SCHEMAS)
}
