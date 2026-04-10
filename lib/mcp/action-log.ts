/**
 * Centralized action logging for MCP tools.
 * Non-blocking fire-and-forget — never throws, never blocks the tool response.
 * Every write operation across all MCP tools calls this after success.
 */

import { createClient } from "@supabase/supabase-js"

interface LogActionParams {
  actor?: string           // "claude.ai" | "claude.code" | "system"
  action_type: string      // "create" | "update" | "delete" | "send" | "advance" | "process"
  table_name: string       // target table or service name (e.g. "accounts", "gmail", "drive")
  record_id?: string       // UUID of affected record
  account_id?: string      // linked CRM account (for cross-reference)
  contact_id?: string      // linked CRM contact (for individual clients without account)
  summary: string          // human-readable one-liner
  details?: Record<string, unknown>  // structured data (fields changed, params, etc.)
}

/**
 * Log an action to the action_log table.
 * MUST be called after every successful write operation.
 * Non-blocking: errors are logged to console but never thrown.
 */
export function logAction(params: LogActionParams): void {
  // Fire and forget — don't await, don't throw
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  Promise.resolve(
    supabase
      .from("action_log")
      .insert({
        actor: params.actor || "claude.ai",
        action_type: params.action_type,
        table_name: params.table_name,
        record_id: params.record_id || null,
        account_id: params.account_id || null,
        contact_id: params.contact_id || null,
        summary: params.summary,
        details: params.details || {},
      })
      .then(({ error }) => {
        if (error) {
          console.error(`[action-log] Insert failed for ${params.table_name}/${params.action_type}: ${error.message}`)
        }
      })
  ).catch((err) => {
    console.error(`[action-log] Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
  })
}
