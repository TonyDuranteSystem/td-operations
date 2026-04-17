/**
 * P3.6 — Config table operation authority layer.
 *
 * Single-entry update path for the three config tables that were
 * previously edited exclusively via raw execute_sql:
 *   - sop_runbooks (17 rows, 53 raw writes/30d)
 *   - pipeline_stages (56 rows, 33 raw writes/30d)
 *   - dev_tasks (232 rows, 52 raw writes/30d)
 *
 * Every update goes through action_log with actor + summary + change
 * details. Optimistic-lock support on updated_at (sop_runbooks +
 * dev_tasks; pipeline_stages has no updated_at column so lock is
 * best-effort).
 *
 * Why: the CRM /config editor (P3.6) needs a guarded surface that
 * matches the shape of the other lib/operations/ helpers
 * (account.ts, document.ts, task.ts). Raw execute_sql was the only
 * way to edit these tables before — ~138 writes/30d across the
 * three, now routed through here.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import type { Database } from "@/lib/database.types"

// ─── Shared result shape ────────────────────────────────────

export interface ConfigUpdateResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  id?: string
  updated_at?: string
  error?: string
}

// ─── updateSOP ──────────────────────────────────────────────

type SOPUpdate = Database["public"]["Tables"]["sop_runbooks"]["Update"]

export interface UpdateSOPParams {
  id: string
  patch: SOPUpdate
  expected_updated_at?: string
  actor?: string
  summary?: string
}

export async function updateSOP(params: UpdateSOPParams): Promise<ConfigUpdateResult> {
  return updateConfigRow("sop_runbooks", params, {
    lockable: true,
    fallbackSummary: "SOP updated",
  })
}

// ─── updatePipelineStage ────────────────────────────────────

type PipelineStageUpdate = Database["public"]["Tables"]["pipeline_stages"]["Update"]

export interface UpdatePipelineStageParams {
  id: string
  patch: PipelineStageUpdate
  actor?: string
  summary?: string
}

export async function updatePipelineStage(
  params: UpdatePipelineStageParams,
): Promise<ConfigUpdateResult> {
  return updateConfigRow(
    "pipeline_stages",
    { ...params, expected_updated_at: undefined },
    { lockable: false, fallbackSummary: "Pipeline stage updated" },
  )
}

// ─── updateDevTask ──────────────────────────────────────────

type DevTaskUpdate = Database["public"]["Tables"]["dev_tasks"]["Update"]

export interface UpdateDevTaskParams {
  id: string
  patch: DevTaskUpdate
  expected_updated_at?: string
  actor?: string
  summary?: string
}

export async function updateDevTask(params: UpdateDevTaskParams): Promise<ConfigUpdateResult> {
  const enrichedPatch: DevTaskUpdate = { ...params.patch }
  // Auto-stamp completed_at when status flips to done (and not already set).
  if (
    enrichedPatch.status === "done" &&
    (enrichedPatch.completed_at === undefined || enrichedPatch.completed_at === null)
  ) {
    enrichedPatch.completed_at = new Date().toISOString()
  }
  return updateConfigRow(
    "dev_tasks",
    { ...params, patch: enrichedPatch },
    { lockable: true, fallbackSummary: "Dev task updated" },
  )
}

// ─── Shared implementation ──────────────────────────────────

type AnyPatch = Record<string, unknown>
interface InternalParams {
  id: string
  patch: AnyPatch
  expected_updated_at?: string
  actor?: string
  summary?: string
}

async function updateConfigRow(
  table: "sop_runbooks" | "pipeline_stages" | "dev_tasks",
  params: InternalParams,
  opts: { lockable: boolean; fallbackSummary: string },
): Promise<ConfigUpdateResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: AnyPatch = { ...params.patch }
    // sop_runbooks + dev_tasks have updated_at; pipeline_stages does
    // not. Only stamp it where the column exists.
    if (opts.lockable) updates.updated_at = nowIso

    // Cast through `any` to dodge the excessively-deep union that arises
    // from branching over three table types. The call-sites already type-
    // gate the patch shape via the exported params interfaces.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabaseAdmin
      .from(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update(updates as any)
      .eq("id", params.id)
    if (opts.lockable && params.expected_updated_at) {
      query = query.eq("updated_at", params.expected_updated_at)
    }

    const selectCols = opts.lockable ? "id, updated_at" : "id"
    const { data, error } = await query.select(selectCols)

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      // Distinguish stale-lock from not_found via a re-read.
      const { data: exists } = await supabaseAdmin
        .from(table)
        .select("id")
        .eq("id", params.id)
        .maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Row ${params.id} not found in ${table}`,
      }
    }

    const row = data[0] as { id: string; updated_at?: string | null }
    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: table,
      record_id: row.id,
      summary: params.summary || `${opts.fallbackSummary} (${changedFields.join(", ")})`,
      details: { fields: changedFields, patch: params.patch },
    })

    return {
      success: true,
      outcome: "updated",
      id: row.id,
      updated_at: (row.updated_at ?? nowIso) as string,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
