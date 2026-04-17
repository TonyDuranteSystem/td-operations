/**
 * P3.4 #7 — Account operation authority layer
 *
 * Single-entry account-update path for status / tier / notes / any
 * field write. Callers:
 *   - Dashboard server actions (app/(dashboard)/accounts/actions.ts
 *     updateAccountField / addAccountNote / changeAccountStatus)
 *   - MCP portal tool (lib/mcp/tools/portal.ts — portal user creation
 *     + legacy transition)
 *   - CRM admin-actions routes (app/api/portal/admin/transition)
 *   - Future: MCP crm_update_record, other API routes.
 *
 * Why: before this, ~7 different call sites did raw
 * `supabaseAdmin.from("accounts").update(...)`. Each had its own
 * logging discipline (some logged, some didn't), some used optimistic
 * locking, some didn't. This function is the single guarded surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import type { Database } from "@/lib/database.types"

// ─── Types ──────────────────────────────────────────────────

type AccountUpdate = Database["public"]["Tables"]["accounts"]["Update"]

export interface UpdateAccountParams {
  id: string
  patch: AccountUpdate
  /**
   * Optional optimistic-lock sentinel. When provided, the update only
   * succeeds if the row's current updated_at matches. If the row was
   * modified between read and write, the call returns
   * { outcome: "stale" }.
   */
  expected_updated_at?: string
  /**
   * Logged to action_log.actor. Defaults to "system" — callers should
   * pass e.g. "dashboard:antonio", "claude.ai", "crm-admin".
   */
  actor?: string
  /**
   * Short human-readable summary for the action_log. Defaults to a
   * generic "Account updated" label.
   */
  summary?: string
  /**
   * Free-form details dict logged to action_log.details. Defaults to
   * the list of changed field names.
   */
  details?: Record<string, unknown>
}

export interface UpdateAccountResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  account_id?: string
  updated_at?: string
  error?: string
}

export interface AppendAccountNoteParams {
  id: string
  note: string
  /** When provided, enables optimistic-lock on the read-before-append. */
  expected_updated_at?: string
  /** Defaults to today (YYYY-MM-DD). */
  date?: string
  actor?: string
}

export interface AppendAccountNoteResult {
  success: boolean
  outcome: "appended" | "stale" | "not_found" | "error" | "empty_note"
  account_id?: string
  error?: string
}

// ─── updateAccount ──────────────────────────────────────────

export async function updateAccount(
  params: UpdateAccountParams
): Promise<UpdateAccountResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: AccountUpdate = { ...params.patch, updated_at: nowIso }

    // Build the update query. Add the optimistic-lock filter when a
    // sentinel is supplied. Select id + updated_at back so callers can
    // detect the stale-row case (0 rows matched).
    let query = supabaseAdmin
      .from("accounts")
      .update(updates)
      .eq("id", params.id)

    if (params.expected_updated_at) {
      query = query.eq("updated_at", params.expected_updated_at)
    }

    const { data, error } = await query.select("id, updated_at")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      // Distinguish stale-lock miss from genuine not_found by re-reading.
      const { data: exists } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .eq("id", params.id)
        .maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Account ${params.id} not found`,
      }
    }

    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "accounts",
      record_id: params.id,
      account_id: params.id,
      summary: params.summary || `Account updated (${changedFields.join(", ")})`,
      details: params.details || { fields: changedFields, patch: params.patch },
    })

    return {
      success: true,
      outcome: "updated",
      account_id: data[0].id,
      updated_at: data[0].updated_at ?? nowIso,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── appendAccountNote ──────────────────────────────────────

/**
 * Prepend a dated note entry to accounts.notes. Format:
 *   "YYYY-MM-DD: <note text>"
 * Newer entries appear first (matches existing dashboard behavior).
 */
export async function appendAccountNote(
  params: AppendAccountNoteParams
): Promise<AppendAccountNoteResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    const trimmed = (params.note || "").trim()
    if (!trimmed) {
      return { success: false, outcome: "empty_note", error: "Note cannot be empty" }
    }

    const { data: account, error: readErr } = await supabaseAdmin
      .from("accounts")
      .select("id, notes, updated_at")
      .eq("id", params.id)
      .maybeSingle()

    if (readErr) {
      return { success: false, outcome: "error", error: readErr.message }
    }
    if (!account) {
      return { success: false, outcome: "not_found", error: `Account ${params.id} not found` }
    }

    const dateStr = params.date || new Date().toISOString().split("T")[0]
    const newEntry = `${dateStr}: ${trimmed}`
    const existing = (account.notes ?? "").trim()
    const combined = existing ? `${newEntry}\n${existing}` : newEntry

    const result = await updateAccount({
      id: params.id,
      patch: { notes: combined },
      expected_updated_at: params.expected_updated_at ?? account.updated_at ?? undefined,
      actor: params.actor,
      summary: "Note added",
      details: { note: trimmed },
    })

    if (!result.success) {
      return {
        success: false,
        outcome: result.outcome === "stale" ? "stale" : "error",
        account_id: params.id,
        error: result.error,
      }
    }

    return { success: true, outcome: "appended", account_id: params.id }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
