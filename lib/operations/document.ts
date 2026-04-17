/**
 * P3.4 #8 — Document operation authority layer
 *
 * Single-entry document-update path for status / category / portal-visibility
 * / file-name / account-linking writes. Callers:
 *   - Dashboard action toggleDocumentPortalVisibility
 *     (app/(dashboard)/accounts/actions.ts)
 *   - MCP portal_transition_setup bulk portal-visibility toggle
 *     (lib/mcp/tools/portal.ts)
 *   - CRM admin transition route bulk portal-visibility toggle
 *     (app/api/portal/admin/transition/route.ts)
 *   - MCP doc_map_folders orphan-to-account linker
 *     (lib/mcp/tools/doc.ts)
 *   - Signature webhook portal-visibility flip
 *     (app/api/signature-request-signed/route.ts)
 *   - Account-file routes: process-and-share (visibility), rename (file_name),
 *     move (category)
 *
 * Why: before this, 8 different call sites did raw
 * `supabaseAdmin.from("documents").update(...)`. Only one of them logged to
 * action_log (the dashboard toggle via safeAction); the other 7 were
 * silent. None used optimistic locking. Lookup keys were inconsistent
 * (some by id, some by drive_file_id + account_id scope). This function
 * is the single guarded surface.
 *
 * Out of scope: doc.ts upsert paths (processFile classify + error
 * fallback). Those are create-or-update on first-time processing, not
 * "edit" semantics. Tracked separately if ever needed.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import type { Database } from "@/lib/database.types"

// ─── Types ──────────────────────────────────────────────────

type DocumentUpdate = Database["public"]["Tables"]["documents"]["Update"]

export interface UpdateDocumentParams {
  /** Lookup by documents.id. One of id or drive_file_id is required. */
  id?: string
  /**
   * Alternate lookup by documents.drive_file_id. Combine with account_id
   * when the caller has scope (e.g., file rename/move routes). If both
   * id and drive_file_id are supplied, id wins.
   */
  drive_file_id?: string
  /** Optional scope for drive_file_id lookup. */
  account_id?: string
  patch: DocumentUpdate
  /**
   * Optimistic-lock sentinel. Only honored when id lookup is used. When
   * the current row's updated_at does not match, the call returns
   * { outcome: "stale" }.
   */
  expected_updated_at?: string
  /** Logged to action_log.actor. Defaults to "system". */
  actor?: string
  /** Short human-readable summary for action_log. */
  summary?: string
  /** Free-form details logged to action_log.details. */
  details?: Record<string, unknown>
}

export interface UpdateDocumentResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  document_id?: string
  drive_file_id?: string
  updated_at?: string
  error?: string
}

export interface UpdateDocumentsBulkParams {
  /** documents.id values to update. Must be non-empty. */
  ids: string[]
  patch: DocumentUpdate
  actor?: string
  summary?: string
  details?: Record<string, unknown>
  /**
   * Optional account_id for action_log.account_id on the aggregate log
   * entry. When the bulk applies to docs from a single account (e.g.,
   * portal-transition), pass it so the log row is scoped.
   */
  account_id?: string
}

export interface UpdateDocumentsBulkResult {
  success: boolean
  outcome: "updated" | "empty" | "error"
  count?: number
  error?: string
}

// ─── updateDocument ────────────────────────────────────────

export async function updateDocument(
  params: UpdateDocumentParams
): Promise<UpdateDocumentResult> {
  try {
    if (!params.id && !params.drive_file_id) {
      return { success: false, outcome: "error", error: "id or drive_file_id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: DocumentUpdate = { ...params.patch, updated_at: nowIso }

    let query = supabaseAdmin.from("documents").update(updates)

    if (params.id) {
      query = query.eq("id", params.id)
      if (params.expected_updated_at) {
        query = query.eq("updated_at", params.expected_updated_at)
      }
    } else {
      // drive_file_id lookup path — optimistic lock not supported here
      // because drive_file_id is not guaranteed unique across accounts.
      query = query.eq("drive_file_id", params.drive_file_id!)
      if (params.account_id) {
        query = query.eq("account_id", params.account_id)
      }
    }

    const { data, error } = await query.select("id, drive_file_id, account_id, updated_at")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      // Distinguish stale-lock miss from genuine not_found by re-reading.
      let readQuery = supabaseAdmin.from("documents").select("id, updated_at")
      if (params.id) readQuery = readQuery.eq("id", params.id)
      else readQuery = readQuery.eq("drive_file_id", params.drive_file_id!)
      if (!params.id && params.account_id) readQuery = readQuery.eq("account_id", params.account_id)
      const { data: exists } = await readQuery.maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Document not found (id=${params.id ?? "—"}, drive_file_id=${params.drive_file_id ?? "—"})`,
      }
    }

    const row = data[0]
    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "documents",
      record_id: row.id,
      account_id: row.account_id ?? undefined,
      summary: params.summary || `Document updated (${changedFields.join(", ")})`,
      details: params.details || { fields: changedFields, patch: params.patch },
    })

    return {
      success: true,
      outcome: "updated",
      document_id: row.id,
      drive_file_id: row.drive_file_id ?? undefined,
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

// ─── updateDocumentsBulk ───────────────────────────────────

/**
 * Apply the same patch to multiple documents by id. Used primarily for
 * bulk portal-visibility toggles (portal transition flows). Writes one
 * aggregate action_log entry covering all affected rows. No optimistic
 * lock — bulk semantics don't combine cleanly with per-row sentinels.
 */
export async function updateDocumentsBulk(
  params: UpdateDocumentsBulkParams
): Promise<UpdateDocumentsBulkResult> {
  try {
    if (!Array.isArray(params.ids) || params.ids.length === 0) {
      return { success: true, outcome: "empty", count: 0 }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: DocumentUpdate = { ...params.patch, updated_at: nowIso }

    const { data, error } = await supabaseAdmin
      .from("documents")
      .update(updates)
      .in("id", params.ids)
      .select("id")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    const count = data?.length ?? 0
    const changedFields = Object.keys(params.patch)

    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "documents",
      account_id: params.account_id,
      summary: params.summary || `Bulk document update — ${count} rows (${changedFields.join(", ")})`,
      details: params.details || {
        requested: params.ids.length,
        matched: count,
        fields: changedFields,
        patch: params.patch,
      },
    })

    return { success: true, outcome: "updated", count }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
