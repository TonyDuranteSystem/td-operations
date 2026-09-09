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

  // .select("id") returns matched rows — if 0, timestamp didn't match.
  //
  // Bug-hunter pass, 2026-09-08 (dev job e7352aa6): this used to auto-retry
  // via the admin client with NO updated_at condition at all — an
  // unconditional overwrite that silently discarded whatever the
  // conflicting write had just recorded, directly contradicting this
  // function's own contract (stated above: "we return an error"). The
  // retry's original justification — a stale Next.js RSC cache serving an
  // old updated_at even though nothing else actually changed the row — is
  // real, but the fix for a stale READ is to refresh and re-check, not to
  // blindly overwrite regardless of what changed. So: retry the match ONCE
  // against the row's CURRENT actual updated_at (bypassing RLS, in case an
  // RLS-scoped client legitimately can't see a value the admin client can);
  // if that also misses, someone genuinely changed this row since it was
  // read, and the caller must be told, not silently overridden.
  if (!data || data.length === 0) {
    const { data: current, error: currentErr } = await supabaseAdmin
      .from(table as never)
      .select("updated_at" as never)
      .eq("id", id)
      .maybeSingle<{ updated_at: string }>()

    if (currentErr) {
      return { success: false, error: currentErr.message }
    }
    if (!current) {
      return { success: false, error: "Record not found — it may have been deleted." }
    }
    if (current.updated_at !== originalUpdatedAt) {
      return { success: false, error: "This record changed since it was loaded — reload and try again." }
    }

    // The row's real current updated_at DOES match what the caller read —
    // the first attempt's miss really was a stale cache read on an
    // otherwise-unchanged row, not a conflicting write. Safe to apply.
    //
    // Second bug-hunter pass, 2026-09-08: this retry write itself needs the
    // SAME row-count check the first attempt has — the re-check read above
    // and this write are two separate calls, so something else can still
    // land in between (any other write to this row, from any origin, not
    // just another updateWithLock call). Without `.select("id")` a 0-row
    // match returns no error at all — the exact fact this function's own
    // comment already establishes about the first attempt — and this was
    // falling through to a false "success" while writing nothing.
    const retryNow = new Date().toISOString()
    const { data: retryData, error: retryError } = await supabaseAdmin
      .from(table as never)
      .update({ ...updates, updated_at: retryNow } as never)
      .eq("id", id)
      .eq("updated_at", originalUpdatedAt)
      .select("id" as never)

    if (retryError) {
      return { success: false, error: retryError.message }
    }
    if (!retryData || (retryData as unknown[]).length === 0) {
      return { success: false, error: "This record changed since it was loaded — reload and try again." }
    }
  }

  return { success: true }
}
