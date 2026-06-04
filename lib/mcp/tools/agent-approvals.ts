/**
 * Agent Approvals — Hermes ↔ Claude bridge (Phase 2: action-authorization rail)
 *
 * Slice 1 is QUEUE + READ only. The worker's propose_action tool writes pending
 * rows into approval_queue (see lib/ai-agent/worker-tools.ts); this file exposes
 * the read side to MCP callers (Claude Code / Hermes) so a human can see what's
 * waiting for approval.
 *
 * One tool:
 *   approval_list — list proposals by status (default 'pending'). READ-ONLY.
 *
 * NOT here (later slices): approve/reject transitions, the claim+execute worker,
 * the portal /portal/team/approvals page, Telegram push. Slice 1 executes nothing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

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
      "Returns up to `limit` rows newest first. READ-ONLY — this tool never approves, rejects, or executes anything.",
    ].join("\n"),
    {
      status: z
        .enum(APPROVAL_STATUS_VALUES)
        .default("pending")
        .describe("Filter by proposal status. Default 'pending'."),
      limit: z.number().int().min(1).max(100).default(20).describe("Max rows (default 20)."),
    },
    async ({ status, limit }) => {
      try {
        const { data, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabaseAdmin as any)
          .from("approval_queue")
          .select(
            "id, batch_id, source_message_id, requested_by, tool_name, params, params_hash, rationale, status, decided_by, decided_at, expires_at, created_at, updated_at",
          )
          .eq("status", status)
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
}
