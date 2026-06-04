/**
 * Outcome callback — Hermes ↔ Claude bridge (Phase 2, Slice 2).
 *
 * When an approval_queue row reaches a terminal state (executed / failed /
 * rejected / expired), we write a durable record back into agent_messages so
 * Hermes (and any reader) can see what happened to a proposed action. This is
 * the "close the loop" step: a proposal that was queued in Slice 1 now reports
 * its outcome.
 *
 * Mapping note: agent_messages models a directed message with `sender` +
 * `recipient` (both NOT NULL, and `sender <> recipient` is a CHECK). The
 * "direction worker→hermes" from the plan maps to sender='worker',
 * recipient='hermes'. subject + body are NOT NULL (1..500 / 1..50000), so we
 * always supply non-empty values. The human-readable outcome goes in `reply`;
 * the structured link back to the approval row goes in `context_json`.
 *
 * Kept deliberately small (imports only supabaseAdmin) so both the executor
 * (lib/ai-agent/approval-executor.ts) and the approval_decide MCP tool
 * (lib/mcp/tools/agent-approvals.ts) can import it without pulling the heavy
 * executeTool graph into the MCP server bundle.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Terminal outcomes that produce a callback. Mirrors approval_status terminals. */
export type OutcomeStatus = "executed" | "failed" | "rejected" | "expired"

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Write a worker→hermes agent_messages row recording the outcome of an approval
 * proposal. Never throws — a callback failure must not mask the action outcome
 * itself; we log and swallow. Returns true if the row was written.
 *
 * @param approvalId    approval_queue.id this outcome belongs to
 * @param toolName      the proposed tool (e.g. send_email)
 * @param summary       human-readable outcome line (goes into reply)
 * @param status        terminal outcome status
 */
export async function writeOutcomeCallback(
  approvalId: string,
  toolName: string,
  summary: string,
  status: OutcomeStatus,
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any).from("agent_messages").insert({
      sender: "worker",
      recipient: "hermes",
      subject: clamp(`Action ${status}: ${toolName}`, 500),
      body: clamp(`Approval ${approvalId} — ${toolName} ${status}.`, 50000),
      status: "done",
      reply: clamp(summary, 200000),
      replied_at: nowIso,
      context_json: {
        approval_id: approvalId,
        tool_name: toolName,
        outcome_status: status,
      },
    })
    if (error) throw error
    return true
  } catch (err) {
    console.warn(
      `[approval-callback] failed to write outcome callback for approval ${approvalId} (${status}):`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
