/**
 * Workflow Dispatch Log — Operational Visibility (Phase 1, Step 1).
 *
 * Records ONE row per workflow-dispatch attempt so that "why did/didn't a
 * task appear for this client" becomes answerable. Today the non-spawn
 * outcomes (no match / ambiguous / failure) only reach throwaway console
 * output and leave no trace.
 *
 * Hard contract — this code is OBSERVATION-ONLY and must NEVER:
 *   - throw (every path is wrapped; failures are swallowed + warn-logged),
 *   - block the dispatch path for long (the insert is timeout-bounded),
 *   - change any dispatch behavior (callers always get the original result),
 *   - write to any table other than workflow_dispatch_log.
 *
 * Writes go through the service-role client (supabaseAdmin), which bypasses
 * the table's row-level security. The table is created in
 * scripts/migrations/20260520-0836-workflow-dispatch-log.sql.
 *
 * Step 1 logs the two event dispatchers (form_submission, sd_created).
 * Chained continuations are Step 1b — the 'chain' source + chained_from_id
 * column already exist so Step 1b needs no schema change.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { DispatchResult } from "@/lib/tasks/dispatch-workflow-for-event"

/** Hard cap on how long a log insert may add to the dispatch path. */
export const LOG_INSERT_TIMEOUT_MS = 2000

export type DispatchTriggerSource = "form_submission" | "sd_created" | "chain"

export interface WorkflowDispatchLogInput {
  trigger_source: DispatchTriggerSource
  /** Human-readable event descriptor (form table name or service_type). */
  event_descriptor?: string | null
  /** Id of the triggering record (submission id, SD id, parent task id). */
  event_ref?: string | null
  /** The dispatcher's structured result — serialized into the row. */
  result: DispatchResult
  account_id?: string | null
  contact_id?: string | null
  delivery_id?: string | null
  actor?: string | null
  /** Step 1b only — always null in Step 1. */
  chained_from_id?: string | null
  /** Extra non-PII context merged into details (form_table, service_type). */
  extra_details?: Record<string, unknown>
}

export interface WorkflowDispatchLogRow {
  trigger_source: string
  event_descriptor: string | null
  event_ref: string | null
  outcome: string
  matched_workflow_slug: string | null
  candidates: string[] | null
  spawned_task_id: string | null
  account_id: string | null
  contact_id: string | null
  delivery_id: string | null
  actor: string | null
  chained_from_id: string | null
  details: Record<string, unknown>
}

/**
 * Pure mapping from a dispatch result + context to a log row. Exported so it
 * can be unit-tested without a database. The `outcome` value is guaranteed to
 * be one of the table's CHECK-allowed values because it derives directly from
 * the dispatcher's DispatchReason union (plus 'spawned').
 */
export function buildDispatchLogRow(input: WorkflowDispatchLogInput): WorkflowDispatchLogRow {
  const r = input.result
  const outcome = r.spawned ? "spawned" : (r.reason ?? "no_trigger_match")

  const details: Record<string, unknown> = { ...(input.extra_details ?? {}) }
  if (r.meta_error) details.meta_error = r.meta_error
  if (r.spawn_error) details.spawn_error = r.spawn_error

  return {
    trigger_source: input.trigger_source,
    event_descriptor: input.event_descriptor ?? null,
    event_ref: input.event_ref ?? null,
    outcome,
    matched_workflow_slug: r.workflow_slug ?? null,
    candidates: r.candidates ?? null,
    spawned_task_id: r.task_id ?? null,
    account_id: input.account_id ?? null,
    contact_id: input.contact_id ?? null,
    delivery_id: input.delivery_id ?? null,
    actor: input.actor ?? null,
    chained_from_id: input.chained_from_id ?? null,
    details,
  }
}

/**
 * Write one dispatch-log row. Never throws; never blocks for more than
 * LOG_INSERT_TIMEOUT_MS. A failure here must never affect the dispatch.
 */
export async function logWorkflowDispatch(input: WorkflowDispatchLogInput): Promise<void> {
  try {
    const row = buildDispatchLogRow(input)

    // The table is sandbox-only until production promotion, so it is not yet
    // in the generated DB types. Narrow escape (no `any`) to insert it.
    const client = supabaseAdmin as unknown as {
      from: (table: string) => {
        insert: (row: WorkflowDispatchLogRow) => PromiseLike<{ error: { message: string } | null }>
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ error: { message: string } | null }>((resolve) => {
      timer = setTimeout(() => resolve({ error: { message: "log_insert_timeout" } }), LOG_INSERT_TIMEOUT_MS)
    })

    const insert = Promise.resolve(client.from("workflow_dispatch_log").insert(row))
    const res = await Promise.race([insert, timeout])
    if (timer) clearTimeout(timer)

    if (res?.error && res.error.message !== "log_insert_timeout") {
      console.warn(`[workflow-dispatch-log] insert failed (non-fatal): ${res.error.message}`)
    }
  } catch (err) {
    console.warn(
      `[workflow-dispatch-log] threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
