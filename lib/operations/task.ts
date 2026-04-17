/**
 * P3.4 #9 — Task operation authority layer
 *
 * Single-entry task-update path for status / priority / assignee /
 * due-date / category / notes / any field write. Callers:
 *   - Dashboard server actions (app/(dashboard)/tasks/actions.ts —
 *     updateTaskStatus / updateTaskPriority / updateTaskAssignee /
 *     updateTask)
 *   - AI agent task tool (lib/ai-agent/tools.ts)
 *   - Service-delivery auto-close cascades (lib/service-delivery.ts)
 *   - Pipeline utilities SS-4 fax close (lib/pipeline-utils.ts)
 *   - CRM admin contact-actions delete-SD cascade
 *   - Future: MCP crm_update_record, other API routes.
 *
 * Why: before this, 8 different call sites did raw
 * `supabaseAdmin.from("tasks").update(...)`. Some logged via
 * safeAction, some via manual action_log insert, most didn't log at
 * all. Some used optimistic locking, some used dbWriteSafe, most
 * used raw writes. This function is the single guarded surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import type { Database } from "@/lib/database.types"

// ─── Types ──────────────────────────────────────────────────

type TaskUpdate = Database["public"]["Tables"]["tasks"]["Update"]

export interface UpdateTaskParams {
  id: string
  patch: TaskUpdate
  /**
   * Optimistic-lock sentinel. When provided, the update only
   * succeeds if the row's current updated_at matches. If the row
   * was modified between read and write, the call returns
   * { outcome: "stale" }.
   */
  expected_updated_at?: string
  /** Logged to action_log.actor. Defaults to "system". */
  actor?: string
  /** Short human-readable summary for the action_log. */
  summary?: string
  /** Free-form details logged to action_log.details. */
  details?: Record<string, unknown>
}

export interface UpdateTaskResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  task_id?: string
  updated_at?: string
  error?: string
}

export interface AppendTaskNoteParams {
  id: string
  note: string
  /** Optimistic lock on the read-before-append. */
  expected_updated_at?: string
  /** Defaults to today (YYYY-MM-DD). */
  date?: string
  actor?: string
}

export interface AppendTaskNoteResult {
  success: boolean
  outcome: "appended" | "stale" | "not_found" | "error" | "empty_note"
  task_id?: string
  error?: string
}

export interface UpdateTasksBulkParams {
  /**
   * One of ids / delivery_id / account_id must be provided as the
   * scope. status_in narrows further. Used mostly by the
   * auto-close cascades when an SD completes.
   */
  ids?: string[]
  delivery_id?: string
  account_id?: string
  /** Only update rows whose current status is in this list. */
  status_in?: string[]
  /** Extra ilike filter on task_title (e.g., "%Fax%SS-4%"). */
  title_ilike?: string
  patch: TaskUpdate
  actor?: string
  summary?: string
  details?: Record<string, unknown>
}

export interface UpdateTasksBulkResult {
  success: boolean
  outcome: "updated" | "empty" | "error"
  count?: number
  ids?: string[]
  error?: string
}

// ─── updateTask ────────────────────────────────────────────

export async function updateTask(
  params: UpdateTaskParams
): Promise<UpdateTaskResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: TaskUpdate = { ...params.patch, updated_at: nowIso }

    // Auto-stamp completed_date when status flips to Done (if caller
    // didn't already set it). Matches the dashboard server-action
    // behavior so the operation is a true drop-in.
    if (
      updates.status === "Done" &&
      (updates.completed_date === undefined || updates.completed_date === null)
    ) {
      updates.completed_date = new Date().toISOString().split("T")[0]
    }

    let query = supabaseAdmin.from("tasks").update(updates).eq("id", params.id)
    if (params.expected_updated_at) {
      query = query.eq("updated_at", params.expected_updated_at)
    }

    const { data, error } = await query.select("id, account_id, updated_at")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      const { data: exists } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("id", params.id)
        .maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Task ${params.id} not found`,
      }
    }

    const row = data[0]
    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "tasks",
      record_id: row.id,
      account_id: row.account_id ?? undefined,
      summary: params.summary || `Task updated (${changedFields.join(", ")})`,
      details: params.details || { fields: changedFields, patch: params.patch },
    })

    return {
      success: true,
      outcome: "updated",
      task_id: row.id,
      updated_at: row.updated_at ?? nowIso,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── appendTaskNote ────────────────────────────────────────

/**
 * Append a dated note entry to tasks.notes. Format:
 *   "YYYY-MM-DD: <note text>"
 * Existing notes appear first (chronological — matches the AI-agent
 * and MCP crm_update_record behavior for tasks).
 */
export async function appendTaskNote(
  params: AppendTaskNoteParams
): Promise<AppendTaskNoteResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    const trimmed = (params.note || "").trim()
    if (!trimmed) {
      return { success: false, outcome: "empty_note", error: "Note cannot be empty" }
    }

    const { data: task, error: readErr } = await supabaseAdmin
      .from("tasks")
      .select("id, notes, updated_at")
      .eq("id", params.id)
      .maybeSingle()

    if (readErr) {
      return { success: false, outcome: "error", error: readErr.message }
    }
    if (!task) {
      return { success: false, outcome: "not_found", error: `Task ${params.id} not found` }
    }

    const dateStr = params.date || new Date().toISOString().split("T")[0]
    const newEntry = `${dateStr}: ${trimmed}`
    const existing = (task.notes ?? "").trim()
    const combined = existing ? `${existing}\n${newEntry}` : newEntry

    const result = await updateTask({
      id: params.id,
      patch: { notes: combined },
      expected_updated_at: params.expected_updated_at ?? task.updated_at ?? undefined,
      actor: params.actor,
      summary: "Note added",
      details: { note: trimmed },
    })

    if (!result.success) {
      return {
        success: false,
        outcome: result.outcome === "stale" ? "stale" : "error",
        task_id: params.id,
        error: result.error,
      }
    }

    return { success: true, outcome: "appended", task_id: params.id }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── updateTasksBulk ───────────────────────────────────────

/**
 * Apply the same patch to multiple tasks matching a filter set.
 * Used primarily for auto-close cascades when a service delivery
 * completes or an SS-4 is signed. Writes one aggregate action_log
 * entry covering all affected rows. No optimistic lock — bulk
 * semantics don't combine cleanly with per-row sentinels.
 */
export async function updateTasksBulk(
  params: UpdateTasksBulkParams
): Promise<UpdateTasksBulkResult> {
  try {
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }
    if (!params.ids?.length && !params.delivery_id && !params.account_id) {
      return { success: false, outcome: "error", error: "scope required: ids, delivery_id, or account_id" }
    }

    const nowIso = new Date().toISOString()
    const updates: TaskUpdate = { ...params.patch, updated_at: nowIso }
    if (
      updates.status === "Done" &&
      (updates.completed_date === undefined || updates.completed_date === null)
    ) {
      updates.completed_date = new Date().toISOString().split("T")[0]
    }

    let query = supabaseAdmin.from("tasks").update(updates)
    if (params.ids && params.ids.length > 0) query = query.in("id", params.ids)
    if (params.delivery_id) query = query.eq("delivery_id", params.delivery_id)
    if (params.account_id) query = query.eq("account_id", params.account_id)
    if (params.status_in && params.status_in.length > 0) {
      query = query.in("status", params.status_in as never)
    }
    if (params.title_ilike) query = query.ilike("task_title", params.title_ilike)

    const { data, error } = await query.select("id")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    const ids = (data ?? []).map(r => r.id)
    const count = ids.length
    if (count === 0) {
      return { success: true, outcome: "empty", count: 0, ids: [] }
    }

    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "tasks",
      account_id: params.account_id,
      summary: params.summary || `Bulk task update — ${count} rows (${changedFields.join(", ")})`,
      details: params.details || {
        matched: count,
        fields: changedFields,
        patch: params.patch,
        scope: {
          ids: params.ids,
          delivery_id: params.delivery_id,
          account_id: params.account_id,
          status_in: params.status_in,
          title_ilike: params.title_ilike,
        },
      },
    })

    return { success: true, outcome: "updated", count, ids }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
