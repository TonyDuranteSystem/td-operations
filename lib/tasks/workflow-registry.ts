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

/**
 * Slice 1: empty.
 * Slice 2 will populate with:
 *   'task.flag_blocked', 'task.waiting_with_optional_message', 'task.snooze',
 *   'task.reassign', 'task.cancel', 'chain.advance_sd_stage',
 *   'chain.spawn_next_workflow', 'chain.send_client_message', 'chain.send_email',
 *   'chain.send_for_signature', 'chain.await_client_action',
 *   'chain.upload_document', 'chain.update_contact_field',
 *   'chain.update_account_field'.
 * Slice 4 will add 'itin.approve_and_send' and 'itin.recall_and_recorrect'.
 */
const HANDLERS: Record<string, WorkflowHandler> = {}

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
