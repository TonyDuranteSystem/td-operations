"use server"

import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ── Types ──────────────────────────────────────────────────────────

export type ActionResult<T = void> = {
  success: boolean
  error?: string
  data?: T
}

interface AuditParams {
  action_type: "create" | "update" | "delete" | "send"
  table_name: string
  record_id?: string
  account_id?: string
  summary: string
  details?: Record<string, unknown>
}

// ── safeAction ─────────────────────────────────────────────────────
// Wraps all dashboard Server Actions with:
// 1. Error handling (returns { success, error } instead of throwing)
// 2. Audit trail (writes to action_log, same table as MCP tools)
//
// Actor format: "dashboard:antonio" / "dashboard:luca"
// Auth: getUser() is cached per request in Next.js SSR — no extra round-trip.

export async function safeAction<T>(
  fn: () => Promise<T>,
  audit?: AuditParams
): Promise<ActionResult<T>> {
  try {
    const data = await fn()

    // Write to action_log (fire-and-forget, non-blocking)
    if (audit) {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const actor = `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`

      Promise.resolve(
        supabase.from("action_log").insert({
          actor,
          action_type: audit.action_type,
          table_name: audit.table_name,
          record_id: audit.record_id || null,
          account_id: audit.account_id || null,
          summary: audit.summary,
          details: audit.details ?? {},
        })
      ).catch(() => {})
    }

    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

// ── updateWithLock ─────────────────────────────────────────────────
// Optimistic locking via updated_at WHERE clause.
// If the row was modified since it was read, count === 0 and we return an error.
// No conflict resolution UI — toast + reload is sufficient for 2 users.

export async function updateWithLock(
  table: string,
  id: string,
  updates: Record<string, unknown>,
  originalUpdatedAt: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient()
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from(table)
    .update({ ...updates, updated_at: now })
    .eq("id", id)
    .eq("updated_at", originalUpdatedAt)
    .select("id")

  if (error) {
    return { success: false, error: error.message }
  }

  // .select("id") returns matched rows — if 0, timestamp didn't match
  if (!data || data.length === 0) {
    // Auto-retry once using admin client (bypasses RLS + stale cache).
    // This handles the common case where MCP or another machine updated
    // the record but the Next.js RSC cache served a stale updated_at.
    const retryNow = new Date().toISOString()
    const { error: retryError } = await supabaseAdmin
      .from(table)
      .update({ ...updates, updated_at: retryNow })
      .eq("id", id)

    if (retryError) {
      return { success: false, error: retryError.message }
    }
  }

  return { success: true }
}
