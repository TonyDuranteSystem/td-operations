/**
 * Agent Approvals — Hermes ↔ Claude bridge (Phase 2: action-authorization rail)
 *
 * Slice 1 is QUEUE + READ only. The worker's propose_action tool writes pending
 * rows into approval_queue (see lib/ai-agent/worker-tools.ts); this file exposes
 * the read side to MCP callers (Claude Code / Hermes) so a human can see what's
 * waiting for approval.
 *
 * Tools:
 *   approval_list   — list proposals by status (default 'pending'). READ-ONLY.
 *   approval_decide — approve or reject a pending proposal (Phase 2, Slice 2).
 *
 * Slice 2 adds approval_decide + the execute worker (app/api/cron/approval-executor).
 * NOT here yet (later slices): the portal /portal/team/approvals page, Telegram push.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getInternalBaseUrl } from "@/lib/mcp/tools/agent-messages"
import { emitApprovalOutcome } from "@/lib/ai-agent/approval-notifications"

/** Who is recorded as the decider. Decisions are always made on Antonio's behalf. */
const DECIDED_BY = "antonio"

/**
 * Fire the executor route for a freshly-approved row — awaited but bounded by a
 * 3s timeout, mirroring fireDirectTrigger in agent-messages.ts. Awaiting
 * guarantees the request leaves this function before the serverless runtime can
 * freeze it; the 3s cap means we don't block on the full action. The executor
 * route runs to completion server-side regardless, and the 5-min cron is the net.
 * Never throws — the row is already 'approved'; the cron scan picks up any miss.
 *
 * Do NOT use waitUntil here (broke the bridge route on Next 14.2 — see
 * docs/systems/agent-bridge.md).
 */
export async function fireExecutorTrigger(approvalId: string): Promise<void> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.warn(`[approval_decide] CRON_SECRET not set — executor trigger skipped for ${approvalId}; cron will pick up.`)
    return
  }
  const url = `${getInternalBaseUrl()}/api/cron/approval-executor?id=${encodeURIComponent(approvalId)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    })
  } catch (err) {
    console.warn(
      `[approval_decide] executor trigger returned/aborted for ${approvalId} (executor continues server-side; cron is the net):`,
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timeout)
  }
}

// Must mirror scripts/migrations/20260604-1100-approval-queue.sql.
const APPROVAL_STATUS_VALUES = [
  "pending",
  "approved",
  "rejected",
  "executing",
  "executed",
  "failed",
  "expired",
] as const

interface ApprovalQueueRow {
  id: string
  batch_id: string | null
  source_message_id: string | null
  requested_by: string
  tool_name: string
  params: Record<string, unknown>
  params_hash: string
  rationale: string | null
  status: string
  decided_by: string | null
  decided_at: string | null
  expires_at: string
  created_at: string
  updated_at: string
}

export function registerAgentApprovalTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════════
  // approval_list — read proposals from the approval rail. READ-ONLY.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "approval_list",
    [
      "List action proposals on the Hermes ↔ Claude approval rail (Phase 2, Slice 1).",
      "",
      "Each row is an action the bridge worker (or Claude Code) PROPOSED for Antonio to approve — it has NOT run. Slice 1 only ever shows 'pending' proposals; approval/execution are later slices.",
      "",
      "status filter (default 'pending'):",
      "  pending | approved | rejected | executing | executed | failed | expired",
      "",
      "batch_id (optional): restrict to one batch — proposals minted together by batch_propose share a batch_id so they can be reviewed as a group.",
      "",
      "Returns up to `limit` rows newest first. READ-ONLY — this tool never approves, rejects, or executes anything.",
    ].join("\n"),
    {
      status: z
        .enum(APPROVAL_STATUS_VALUES)
        .default("pending")
        .describe("Filter by proposal status. Default 'pending'."),
      batch_id: z.string().uuid().optional().describe("Optional: restrict to one batch_id (group of proposals)."),
      limit: z.number().int().min(1).max(100).default(20).describe("Max rows (default 20)."),
    },
    async ({ status, batch_id, limit }) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query = (supabaseAdmin as any)
          .from("approval_queue")
          .select(
            "id, batch_id, source_message_id, requested_by, tool_name, params, params_hash, rationale, status, decided_by, decided_at, expires_at, created_at, updated_at",
          )
          .eq("status", status)
        if (batch_id) query = query.eq("batch_id", batch_id)
        const { data, error } = await query
          .order("created_at", { ascending: false })
          .limit(limit)

        if (error) throw error

        const rows = (data ?? []) as ApprovalQueueRow[]
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `📭 No proposals with status='${status}'.` }] }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ approval_list error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // approval_decide — approve or reject a pending proposal (Phase 2, Slice 2).
  // approve → flips pending→approved and fires the executor (runs the REAL action).
  // reject  → flips pending→rejected and writes an outcome callback to Hermes.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "approval_decide",
    [
      "Approve or reject a PENDING action proposal on the Hermes ↔ Claude approval rail (Phase 2, Slice 2).",
      "",
      "🛑 MANDATORY APPROVAL DISCIPLINE — DO NOT call this with decision='approve' on your own judgement.",
      "Hermes (or Claude Code) must FIRST show Antonio the exact tool_name + params + any recipient/cascade/external flags (use approval_list to read the row) and WAIT for Antonio's explicit OK. Only then call approval_decide(approve). Same rule as gmail_send / agent_msg_send.",
      "",
      "decision='approve':",
      "  - Atomically flips the row pending→approved (no-op if it isn't pending).",
      "  - Fires the executor (/api/cron/approval-executor) which runs the REAL action now.",
      "  - The outcome is written back to the row (status executed/failed) AND as an agent_messages callback to Hermes.",
      "",
      "decision='reject':",
      "  - Atomically flips the row pending→rejected (no-op if it isn't pending).",
      "  - Writes an agent_messages callback so Hermes can report the rejection. Pass `note` to explain why.",
      "",
      "Only PENDING rows can be decided. An already-approved/rejected/expired/executed row returns a no-op message.",
    ].join("\n"),
    {
      id: z.string().uuid().describe("approval_queue row id to decide."),
      decision: z.enum(["approve", "reject"]).describe("'approve' runs the action; 'reject' cancels it."),
      note: z.string().max(10000).optional().describe("Optional note (recorded; surfaced to Hermes on reject)."),
    },
    async ({ id, decision, note }) => {
      try {
        const nowIso = new Date().toISOString()

        if (decision === "approve") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error } = await (supabaseAdmin as any)
            .from("approval_queue")
            .update({ status: "approved", decided_by: DECIDED_BY, decided_at: nowIso, updated_at: nowIso })
            .eq("id", id)
            .eq("status", "pending")
            .select("id, tool_name, status")
            .maybeSingle()

          if (error) throw error
          if (!data) {
            return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} is not pending (already decided, expired, or not found). No change.` }] }
          }

          // Run the action now (awaited, 3s-bounded); cron is the net.
          await fireExecutorTrigger(id)

          return {
            content: [{
              type: "text" as const,
              text: [
                `✅ Approved proposal ${id} (${data.tool_name}).`,
                `Executor triggered — the action is running now. Poll approval_list(status='executed') / approval_list(status='failed') for the outcome (or read the agent_messages callback to Hermes).`,
              ].join("\n"),
            }],
          }
        }

        // reject
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabaseAdmin as any)
          .from("approval_queue")
          .update({ status: "rejected", decided_by: DECIDED_BY, decided_at: nowIso, updated_at: nowIso })
          .eq("id", id)
          .eq("status", "pending")
          .select("id, tool_name, status, params, rationale")
          .maybeSingle()

        if (error) throw error
        if (!data) {
          return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} is not pending (already decided, expired, or not found). No change.` }] }
        }

        const reason = note && note.trim().length > 0 ? note.trim() : "(no reason given)"
        // Writes the Hermes callback, flips notification_sent, and mirrors to the
        // CRM team chat (Phase B). notification_sent prevents the executor's
        // retry sweep from duplicating this rejection notification.
        await emitApprovalOutcome({
          id,
          tool_name: data.tool_name,
          status: "rejected",
          summary: `Proposal ${data.tool_name} rejected: ${reason}`,
          row: { id, tool_name: data.tool_name, params: data.params ?? null, rationale: data.rationale ?? null },
          detail: reason,
        })

        return {
          content: [{
            type: "text" as const,
            text: `🛑 Rejected proposal ${id} (${data.tool_name}). Reason: ${reason}. Hermes has been notified.`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ approval_decide error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )
}
