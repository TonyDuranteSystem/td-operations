/**
 * Contact operation authority layer — mirrors updateTask / updateAccount.
 *
 * Single-entry contact-update path so all `contacts` writes go through one
 * helper that handles optimistic locking, action_log audit, and the
 * P2.4 ESLint rule (no raw .insert/.update/.upsert on protected tables).
 *
 * Callers:
 *   - chain.update_contact_field workflow handler
 *   - (future) MCP crm_update_record contact branch
 *   - (future) AI agent contact tool
 *
 * Current raw-update sites in lib/operations/formation-materialize.ts and
 * elsewhere predate this helper and should be migrated when touched. Not in
 * this slice's scope.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { syncPortalLoginEmail, type LoginEmailSyncResult } from "@/lib/operations/portal-login-email"
import type { Database } from "@/lib/database.types"

type ContactUpdate = Database["public"]["Tables"]["contacts"]["Update"]

export interface UpdateContactParams {
  id: string
  patch: ContactUpdate
  /** Optimistic-lock sentinel. */
  expected_updated_at?: string
  /** action_log actor. Defaults to "system". */
  actor?: string
  /** Short summary for action_log.summary. */
  summary?: string
  /** Free-form details for action_log.details. */
  details?: Record<string, unknown>
}

export interface UpdateContactResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  contact_id?: string
  updated_at?: string
  error?: string
  /** Present when the patch changed `email` — the result of syncing the portal login. */
  loginEmailSync?: LoginEmailSyncResult
}

export async function updateContact(params: UpdateContactParams): Promise<UpdateContactResult> {
  try {
    if (!params.id) {
      return { success: false, outcome: "error", error: "id is required" }
    }
    if (!params.patch || Object.keys(params.patch).length === 0) {
      return { success: false, outcome: "error", error: "patch must contain at least one field" }
    }

    const nowIso = new Date().toISOString()
    const updates: ContactUpdate = { ...params.patch, updated_at: nowIso }

    let query = supabaseAdmin.from("contacts").update(updates).eq("id", params.id)
    if (params.expected_updated_at) {
      query = query.eq("updated_at", params.expected_updated_at)
    }

    const { data, error } = await query.select("id, updated_at")

    if (error) {
      return { success: false, outcome: "error", error: error.message }
    }

    if (!data || data.length === 0) {
      const { data: exists } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("id", params.id)
        .maybeSingle()
      return {
        success: false,
        outcome: exists ? "stale" : "not_found",
        error: exists
          ? "Row was modified since it was read (optimistic lock)"
          : `Contact ${params.id} not found`,
      }
    }

    const row = data[0]
    const changedFields = Object.keys(params.patch)
    logAction({
      actor: params.actor || "system",
      action_type: "update",
      table_name: "contacts",
      record_id: row.id,
      summary: params.summary || `Contact updated (${changedFields.join(", ")})`,
      details: params.details || { fields: changedFields, patch: params.patch },
    })

    // Keep the portal LOGIN email in sync with the contact email. Best-effort:
    // a sync failure/conflict NEVER fails the contact update — the outcome is
    // surfaced in `loginEmailSync` for the caller to flag. (R: "when we update an
    // email, the login must update automatically.")
    let loginEmailSync: LoginEmailSyncResult | undefined
    if (Object.prototype.hasOwnProperty.call(params.patch, "email") && params.patch.email) {
      try {
        const { data: c } = await supabaseAdmin
          .from("contacts")
          .select("full_name, language")
          .eq("id", params.id)
          .maybeSingle()
        loginEmailSync = await syncPortalLoginEmail({
          contactId: params.id,
          newEmail: String(params.patch.email),
          language: c?.language ?? null,
          fullName: c?.full_name ?? null,
        })
      } catch (e) {
        loginEmailSync = { status: "error", error: e instanceof Error ? e.message : String(e) }
      }
    }

    return {
      success: true,
      outcome: "updated",
      contact_id: row.id,
      updated_at: row.updated_at ?? nowIso,
      loginEmailSync,
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
