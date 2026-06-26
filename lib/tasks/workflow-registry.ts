/**
 * Workflow Handler Registry — maps action.handler slugs to handler functions.
 *
 * Add new handlers here as the system grows. Catalog rows reference handlers
 * by slug; the exhaustiveness test asserts every referenced handler is
 * registered (build fails before deploy if any catalog row points at a
 * missing handler).
 *
 * Pattern mirrored from lib/jobs/registry.ts.
 *
 * Slice 1 ships this map empty. Slice 2 adds the generic handlers
 * (task.* and chain.*). Slice 4+ add service-specific handlers
 * (itin.approve_and_send, etc.).
 *
 * See: sysdoc 'workflows-system-master-plan' §Architecture/Handler registry.
 */

import type { WorkflowHandler } from "./types"

// Task lifecycle handlers (Slice 2).
import { taskFlagBlocked } from "./workflow-handlers/task-flag-blocked"
import { taskWaitingWithOptionalMessage } from "./workflow-handlers/task-waiting-with-optional-message"
import { taskSnooze } from "./workflow-handlers/task-snooze"
import { taskReassign } from "./workflow-handlers/task-reassign"
import { taskCancel } from "./workflow-handlers/task-cancel"

// Chain primitives (Slice 2).
import { chainAdvanceSdStage } from "./workflow-handlers/chain-advance-sd-stage"
import { chainSpawnNextWorkflow } from "./workflow-handlers/chain-spawn-next-workflow"
import { chainSendClientMessage } from "./workflow-handlers/chain-send-client-message"
import { chainSendEmail } from "./workflow-handlers/chain-send-email"
import { chainSendForSignature } from "./workflow-handlers/chain-send-for-signature"
import { chainAwaitClientAction } from "./workflow-handlers/chain-await-client-action"
import { chainUploadDocument } from "./workflow-handlers/chain-upload-document"
import { chainUpdateContactField } from "./workflow-handlers/chain-update-contact-field"
import { chainUpdateAccountField } from "./workflow-handlers/chain-update-account-field"

// Service-specific handlers (Slice 4 + Slice 5.1).
// itin.approve_and_send + itin.recall_and_recorrect were REMOVED 2026-06-25
// (branch fix/itin-workspace-only): the ITIN flow is now driven exclusively by
// the workspace (/flows/[sd_id]). The old "Approve & Send" email handler and
// its recall sibling no longer exist — the workspace advance button posts the
// client a portal chat message instead of emailing the PDFs, and itin_review is
// a plain notification pointing to the workspace (not a workflow task).
import { itinConfirmNumberReceived } from "./workflow-handlers/itin-confirm-number-received"

// Service-specific handlers (Slice 8 — banking + tax).
// One banking handler (not per-provider) — provider-specific copy lives in
// task_workflows.metadata.actions[].handler_params.followup_task per
// the Principle of Flexibility: adding a new banking provider is a SQL
// row insert, never a code change.
import { bankingApproveForm } from "./workflow-handlers/banking-approve-form"
import { taxApproveAndApply } from "./workflow-handlers/tax-approve-and-apply"

// Service + generic SD-lifecycle handlers (Slice 9 — closure/formation/onboarding).
// One generic primitive (sd.mark_complete, parameterized by handler_params)
// + two service-specific handlers where MCP wrapping or coordinated multi-write
// needs in-handler logic. Most stage transitions in Slice 9 workflows reuse
// chain.advance_sd_stage with handler_params.target_stage — zero new code.
import { closureApproveData } from "./workflow-handlers/closure-approve-data"
import { formationConfirmEinReceived } from "./workflow-handlers/formation-confirm-ein-received"
import { sdMarkComplete } from "./workflow-handlers/sd-mark-complete"

/**
 * Slice 2: 5 task.* + 9 chain.* handlers registered.
 * Slice 4 will add 'itin.approve_and_send' and 'itin.recall_and_recorrect'.
 *
 * `chain.send_for_signature` and `chain.upload_document` are intentional
 * NOT_IMPLEMENTED stubs — their underlying helpers (lib/operations/signature.ts,
 * lib/operations/document.ts::insertDocument) have not been extracted yet.
 * Tracked as follow-up dev_tasks. Calling them via the dispatcher returns a
 * clean handler error; no silent failure.
 */
const HANDLERS: Record<string, WorkflowHandler> = {
  // Task lifecycle
  "task.flag_blocked": taskFlagBlocked,
  "task.waiting_with_optional_message": taskWaitingWithOptionalMessage,
  "task.snooze": taskSnooze,
  "task.reassign": taskReassign,
  "task.cancel": taskCancel,
  // Chain primitives
  "chain.advance_sd_stage": chainAdvanceSdStage,
  "chain.spawn_next_workflow": chainSpawnNextWorkflow,
  "chain.send_client_message": chainSendClientMessage,
  "chain.send_email": chainSendEmail,
  "chain.send_for_signature": chainSendForSignature, // stub
  "chain.await_client_action": chainAwaitClientAction,
  "chain.upload_document": chainUploadDocument, // stub
  "chain.update_contact_field": chainUpdateContactField,
  "chain.update_account_field": chainUpdateAccountField,
  // Service-specific (Slice 5.1) — itin.approve_and_send + itin.recall_and_recorrect
  // removed 2026-06-25 (workspace-only ITIN flow). confirm_number_received stays
  // (itin_irs_processing → itin_number_received chain remains catalog-driven).
  "itin.confirm_number_received": itinConfirmNumberReceived,
  // Service-specific (Slice 8 — banking + tax)
  "banking.approve_form": bankingApproveForm,
  "tax.approve_and_apply": taxApproveAndApply,
  // Slice 9 — SD-lifecycle (closure / formation / onboarding)
  "closure.approve_data": closureApproveData,
  "formation.confirm_ein_received": formationConfirmEinReceived,
  "sd.mark_complete": sdMarkComplete,
}

/** Look up a handler by slug. Returns null if not registered. */
export function getWorkflowHandler(slug: string): WorkflowHandler | null {
  return HANDLERS[slug] ?? null
}

/** Throws a clear error if a handler is missing. Used by the dispatcher. */
export function requireWorkflowHandler(slug: string): WorkflowHandler {
  const fn = HANDLERS[slug]
  if (!fn) {
    throw new Error(
      `Workflow handler '${slug}' is not registered. ` +
        `Either register it in lib/tasks/workflow-registry.ts or fix the catalog row that references it.`,
    )
  }
  return fn
}

/** All registered handler slugs. Used by the exhaustiveness test. */
export function getRegisteredHandlerSlugs(): string[] {
  return Object.keys(HANDLERS)
}

/**
 * Internal-only: register a handler at module load time. Used by handler
 * modules; not exported from the package's public surface. Currently unused
 * (Slice 1 ships the map empty), but here so Slice 2 handlers can opt into
 * self-registration if they prefer over central wiring.
 *
 * The central-wiring pattern (mutating HANDLERS via static imports in this
 * file) is the default and what the exhaustiveness test verifies.
 */
export function _registerHandler(slug: string, fn: WorkflowHandler): void {
  if (HANDLERS[slug]) {
    throw new Error(`Workflow handler '${slug}' is already registered.`)
  }
  HANDLERS[slug] = fn
}
