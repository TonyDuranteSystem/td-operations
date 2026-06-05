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
import { computeParamsHash } from "@/lib/ai-agent/approvable-tools"
import { currentApprovalEnv } from "@/lib/ai-agent/approval-env"

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
  confirmation_code: string | null
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
            "id, batch_id, source_message_id, requested_by, tool_name, params, params_hash, rationale, status, decided_by, decided_at, confirmation_code, expires_at, created_at, updated_at",
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
      "decision='approve' (REQUIRES confirmation_code):",
      "  - You MUST pass the 6-digit confirmation_code shown on the proposal card (🔑 Code on the approval_list / formatted view). A missing or wrong code is rejected — the action does NOT run. This binds the approval to one specific proposal so it can't fire by accident or by typo'ing the wrong id.",
      "  - Atomically flips the row pending→approved (no-op if it isn't pending).",
      "  - Fires the executor (/api/cron/approval-executor) which runs the REAL action now.",
      "  - The outcome is written back to the row (status executed/failed) AND as an agent_messages callback to Hermes.",
      "",
      "decision='reject' (no code needed):",
      "  - Atomically flips the row pending→rejected (no-op if it isn't pending).",
      "  - Writes an agent_messages callback so Hermes can report the rejection. Pass `note` to explain why.",
      "",
      "Only PENDING rows can be decided. An already-approved/rejected/expired/executed row returns a no-op message.",
    ].join("\n"),
    {
      id: z.string().uuid().describe("approval_queue row id to decide."),
      decision: z.enum(["approve", "reject"]).describe("'approve' runs the action; 'reject' cancels it."),
      confirmation_code: z
        .string()
        .optional()
        .describe("REQUIRED on approve: the 6-digit code shown on the proposal card. Ignored on reject."),
      note: z.string().max(10000).optional().describe("Optional note (recorded; surfaced to Hermes on reject)."),
    },
    async ({ id, decision, confirmation_code, note }) => {
      try {
        const nowIso = new Date().toISOString()

        if (decision === "approve") {
          // Confirmation-code gate (WP1): an approve must carry the exact 6-digit
          // code minted for THIS proposal. Verify before the atomic flip so a
          // missing/wrong code never moves the row. The code is immutable, so
          // reading it first is race-safe; status atomicity is preserved by the
          // .eq('status','pending') guard on the UPDATE below.
          const providedCode = (confirmation_code ?? "").trim()
          if (!providedCode) {
            return { content: [{ type: "text" as const, text: `❌ Confirmation code required to approve proposal ${id}. Pass the 6-digit code shown on the proposal card.` }] }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: row, error: readErr } = await (supabaseAdmin as any)
            .from("approval_queue")
            .select("id, status, confirmation_code")
            .eq("id", id)
            .maybeSingle()
          if (readErr) throw readErr
          if (!row) {
            return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} not found. No change.` }] }
          }
          if (row.status !== "pending") {
            return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} is not pending (already decided, expired, or executed). No change.` }] }
          }
          const storedCode = (row.confirmation_code ?? "").trim()
          if (!storedCode || providedCode !== storedCode) {
            return { content: [{ type: "text" as const, text: `❌ Invalid confirmation code for proposal ${id}. The action was NOT approved.` }] }
          }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // hermes_heartbeat — Operating-Agent liveness ping (WP1).
  // The Hermes instance calls this on a timer so the health monitor
  // (/api/cron/hermes-health) can detect when it goes offline. Upserts one row
  // per instance_id, stamping last_heartbeat + status='online'.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "hermes_heartbeat",
    [
      "Record a liveness heartbeat for a Hermes Operating-Agent instance (WP1).",
      "Call this on a timer (e.g. every minute) so the health monitor can tell when the instance goes offline.",
      "Upserts hermes_instances by instance_id: stamps last_heartbeat=now and status='online'.",
    ].join("\n"),
    {
      instance_id: z.string().min(1).max(200).describe("Stable identifier for this Hermes instance (e.g. 'hermes-mac-mini')."),
    },
    async ({ instance_id }) => {
      try {
        const nowIso = new Date().toISOString()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabaseAdmin as any)
          .from("hermes_instances")
          .upsert(
            { instance_id, last_heartbeat: nowIso, status: "online", updated_at: nowIso },
            { onConflict: "instance_id" },
          )
          .select("instance_id, last_heartbeat")
          .single()
        if (error) throw error
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ ok: true, instance_id: data?.instance_id ?? instance_id, last_heartbeat: data?.last_heartbeat ?? nowIso }),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ hermes_heartbeat error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // approval_claim — Operating-Agent pulls the next approved action to run (WP1).
  // Atomically claims the oldest approved + unclaimed row in THIS env lane,
  // flipping it approved→executing with claimed_by=instance_id. Re-checks the
  // params_hash integrity before handing the row back; a mismatch fails the row
  // (never executed) and returns an error. Returns the full row, or null if there
  // is nothing to claim.
  //
  // PostgREST cannot ORDER BY … LIMIT on an UPDATE, so we SELECT the oldest
  // candidates then attempt a GUARDED update per candidate. The guard
  // (status='approved' AND claimed_by IS NULL) makes the update a single-winner
  // even if two instances target the same row; a lost race (0 rows) falls through
  // to the next candidate. This is the only double-claim guard — do not weaken it.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "approval_claim",
    [
      "Claim the next APPROVED action for this Operating-Agent instance to execute (WP1).",
      "",
      "Atomically moves the oldest approved + unclaimed proposal (in this environment lane) to status='executing', tagged with your instance_id. Re-verifies the params integrity hash before returning; an integrity mismatch fails the row and it is NOT handed to you.",
      "",
      "Returns the full row to execute (id, tool_name, params, rationale, thread_id, confirmation_code) — or a 'nothing to claim' message if no approved work is waiting.",
      "",
      "After you run the action, you MUST call approval_complete(id, status, result/error_text) to close the loop. A claimed row left in 'executing' is recovered by the cron safety net after 10 minutes.",
    ].join("\n"),
    {
      instance_id: z.string().min(1).max(200).describe("This Hermes instance's identifier (also used as claimed_by)."),
    },
    async ({ instance_id }) => {
      try {
        const lane = currentApprovalEnv()
        // 1) Oldest approved + unclaimed candidates in this lane.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: candidates, error: selErr } = await (supabaseAdmin as any)
          .from("approval_queue")
          .select("id")
          .eq("status", "approved")
          .is("claimed_by", null)
          .eq("env", lane)
          .order("created_at", { ascending: true })
          .limit(10)
        if (selErr) throw selErr

        const ids = ((candidates ?? []) as Array<{ id: string }>).map((r) => r.id)
        if (ids.length === 0) {
          return { content: [{ type: "text" as const, text: "📭 Nothing to claim — no approved actions waiting." }] }
        }

        // 2) Guarded atomic claim, oldest first; first row returned wins.
        const nowIso = new Date().toISOString()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let claimed: any = null
        for (const candidateId of ids) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error } = await (supabaseAdmin as any)
            .from("approval_queue")
            .update({ status: "executing", claimed_by: instance_id, claimed_at: nowIso, updated_at: nowIso })
            .eq("id", candidateId)
            .eq("status", "approved")
            .is("claimed_by", null)
            .select("id, tool_name, params, params_hash, rationale, thread_id, confirmation_code")
            .maybeSingle()
          if (error) throw error
          if (data) {
            claimed = data
            break
          }
          // 0 rows → another instance claimed this id first; try the next candidate.
        }

        if (!claimed) {
          return { content: [{ type: "text" as const, text: "📭 Nothing to claim — candidates were taken by another instance." }] }
        }

        // 3) Integrity re-check: stored params must still hash to params_hash. A
        //    mismatch fails the row (never executed) — drift/tamper guard.
        const recomputed = computeParamsHash(claimed.params ?? {})
        if (recomputed !== claimed.params_hash) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any)
            .from("approval_queue")
            .update({ status: "failed", error_text: "integrity", executed_at: nowIso, executed_by: instance_id, updated_at: nowIso })
            .eq("id", claimed.id)
          await emitApprovalOutcome({
            id: claimed.id,
            tool_name: claimed.tool_name,
            status: "failed",
            summary: `Proposal ${claimed.tool_name} NOT executed: params integrity mismatch (stored params changed since approval).`,
            row: { id: claimed.id, tool_name: claimed.tool_name, params: claimed.params ?? null, rationale: claimed.rationale ?? null },
            detail: "integrity",
          })
          return { content: [{ type: "text" as const, text: `❌ Claimed proposal ${claimed.id} failed integrity check — marked failed, not executed.` }] }
        }

        // 4) Hand the row to the Operating Agent.
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id: claimed.id,
              tool_name: claimed.tool_name,
              params: claimed.params ?? {},
              rationale: claimed.rationale ?? null,
              thread_id: claimed.thread_id ?? null,
              confirmation_code: claimed.confirmation_code ?? null,
            }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ approval_claim error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // approval_complete — Operating-Agent reports an executed/failed outcome (WP1).
  // Closes a row the instance previously claimed: writes status + result/error,
  // stamps executed_at + executed_by (= the claiming instance), then emits the
  // outcome notification (Hermes callback + CRM mirror). Idempotent: only a row
  // still in 'executing' is finalized; any other status is a no-op.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "approval_complete",
    [
      "Report the outcome of an action you claimed via approval_claim (WP1).",
      "",
      "status='executed': the action ran successfully — pass the tool's result as `result`.",
      "status='failed': the action failed — pass `error_text` explaining why.",
      "",
      "Finalizes the row (status + result/error + executed_at + executed_by) and notifies Hermes + the CRM team chat. Idempotent: only a row still in 'executing' is finalized; calling on an already-completed row is a no-op.",
    ].join("\n"),
    {
      id: z.string().uuid().describe("approval_queue row id you claimed."),
      status: z.enum(["executed", "failed"]).describe("Outcome of running the action."),
      result: z.record(z.string(), z.unknown()).optional().describe("On success: the action's result object (stored as JSON)."),
      error_text: z.string().max(10000).optional().describe("On failure: why the action failed."),
    },
    async ({ id, status, result, error_text }) => {
      try {
        // Read the claimed row (need claimed_by for executed_by, plus context for
        // the outcome notification). Validate it is actually in 'executing'.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: row, error: readErr } = await (supabaseAdmin as any)
          .from("approval_queue")
          .select("id, status, claimed_by, tool_name, params, rationale")
          .eq("id", id)
          .maybeSingle()
        if (readErr) throw readErr
        if (!row) {
          return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} not found. No change.` }] }
        }
        if (row.status !== "executing") {
          return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} is not 'executing' (status='${row.status}') — already completed or never claimed. No change.` }] }
        }

        const nowIso = new Date().toISOString()
        const patch: Record<string, unknown> = {
          status,
          executed_at: nowIso,
          executed_by: row.claimed_by ?? null,
          notification_sent: false,
          updated_at: nowIso,
        }
        if (result !== undefined) patch.result = result
        if (error_text !== undefined) patch.error_text = error_text.slice(0, 10000)

        // Guarded finalize — only flips a row still in 'executing' (idempotent /
        // race-safe against a concurrent completion or the cron recovery).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: done, error } = await (supabaseAdmin as any)
          .from("approval_queue")
          .update(patch)
          .eq("id", id)
          .eq("status", "executing")
          .select("id, tool_name")
          .maybeSingle()
        if (error) throw error
        if (!done) {
          return { content: [{ type: "text" as const, text: `⚠️ Proposal ${id} was completed by another caller. No change.` }] }
        }

        // Notify Hermes (durable callback) + mirror to the CRM team chat. This
        // also flips notification_sent back to TRUE on success, so the executor's
        // retry sweep won't duplicate it.
        const summary =
          status === "executed"
            ? `Proposal ${row.tool_name} executed successfully.`
            : `Proposal ${row.tool_name} failed: ${error_text ?? "unknown error"}.`
        await emitApprovalOutcome({
          id,
          tool_name: row.tool_name,
          status,
          summary,
          row: { id, tool_name: row.tool_name, params: row.params ?? null, rationale: row.rationale ?? null },
          detail: status === "failed" ? (error_text ?? null) : null,
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Proposal ${id} (${row.tool_name}) marked ${status}. Hermes + CRM notified.`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ approval_complete error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )
}
