/**
 * Agent Messages — Hermes ↔ Claude bridge (Phase 1: discussion/research rail)
 *
 * dev_task: 1a0d1354 (parent umbrella: 1717570c)
 * docs: see docs/systems/ (Phase 1 ships; doc TBD in same change per R107)
 *
 * Three tools:
 *   agent_msg_send    — Hermes calls this to ask Claude something. Triggers the
 *                       worker immediately (fire-and-forget fetch) AND the 5-min
 *                       cron picks it up as a safety net.
 *   agent_inbox_list  — Claude Code or Hermes lists messages from a perspective.
 *   agent_inbox_reply — Manual fallback if the cron worker is unavailable.
 *
 * Authorization rail (approval_queue + portal) is a separate Phase 2.
 * R107: this is a NEW subsystem; a docs/systems/agent-bridge.md must be created
 * as part of the same change. (Pending in the build sequence.)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

// Enums must mirror scripts/migrations/20260603-1510-agent-messages-bridge.sql.
const PARTY_VALUES = ["hermes", "claude", "worker"] as const
const STATUS_VALUES = ["pending", "processing", "done", "failed", "cancelled"] as const

type Party = (typeof PARTY_VALUES)[number]
type Status = (typeof STATUS_VALUES)[number]

interface AgentMessageRow {
  id: string
  sender: Party
  recipient: Party
  subject: string
  body: string
  status: Status
  reply: string | null
  replied_at: string | null
  claimed_at: string | null
  claimed_by: string | null
  context_json: Record<string, unknown>
  idempotency_key: string | null
  error_text: string | null
  created_at: string
  updated_at: string
}

/**
 * Resolve the absolute base URL for the direct-trigger self-call so it lands on
 * the SAME Vercel project (⇒ same Supabase DB + same CRON_SECRET) as the row we
 * just inserted, on a public alias that runs the route.
 *
 * Resolution order:
 *   1. Explicit override — `APP_BASE_URL` (full URL). For local tunnels / scripts.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` — the current project's STABLE production
 *      alias (the prod project's alias in prod, the sandbox project's alias in
 *      sandbox). Vercel injects it on every deployment.
 *   3. Local dev fallback — http://localhost:3000.
 *
 * ⚠️ Deliberately does NOT use `VERCEL_URL`. That is the DEPLOYMENT-SPECIFIC host
 * (e.g. td-operations-abc123.vercel.app), which sits behind Vercel Deployment
 * Protection and returns 401 to unauthenticated server-to-server self-calls — so
 * the direct trigger never reached the worker route and rows stayed pending with
 * claimed_at=null (the cron net then claimed them late as 'cron-worker'). Same bug
 * class fixed for PDF font self-fetches in lib/pdf/unicode-fonts.ts (commits
 * b953aaa / 386390a). Shared by fireExecutorTrigger (approval-executor) too.
 */
export function getInternalBaseUrl(): string {
  if (process.env.APP_BASE_URL && process.env.APP_BASE_URL.startsWith("http")) {
    return process.env.APP_BASE_URL.replace(/\/$/, "")
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/\/$/, "")}`
  }
  return "http://localhost:3000"
}

/**
 * Fire the direct-trigger POST to the cron worker, AWAITED but bounded by a 3s
 * timeout. Awaiting guarantees the request actually leaves this MCP function
 * before the serverless runtime can freeze it — a previous fire-and-forget
 * version was getting killed on freeze, so rows only got processed by the 5-min
 * cron (~1-5 min latency). The 3s timeout is long enough to hand the row to the
 * worker route (which then runs the sonnet loop to completion SERVER-SIDE,
 * independent of this client connection) but short enough that agent_msg_send
 * returns to Hermes promptly. Never throws — the row is already inserted and the
 * 5-min cron is the safety net for any failure.
 *
 * Exported for unit tests.
 */
export async function fireDirectTrigger(messageId: string): Promise<void> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.warn(`[agent_msg_send] CRON_SECRET not set — direct trigger skipped for ${messageId}; cron will pick up.`)
    return
  }
  const url = `${getInternalBaseUrl()}/api/cron/hermes-bridge?message_id=${encodeURIComponent(messageId)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    })
  } catch (err) {
    // Aborting at 3s is expected and fine — the worker route keeps running
    // server-side. Any other failure falls through to the 5-min cron safety net.
    console.warn(
      `[agent_msg_send] direct trigger returned/aborted for ${messageId} (worker continues server-side; cron is the net):`,
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function registerAgentMessageTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════════
  // agent_msg_send — Hermes (or Claude/worker) inserts a message addressed to
  // another agent. On insert, fires the worker directly (fire-and-forget) AND
  // the 5-min cron sweeps as a safety net.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "agent_msg_send",
    [
      "Drop a message into the agent_messages bridge addressed to another agent (Hermes ↔ Claude/worker, Phase 1).",
      "",
      "🛑 MANDATORY APPROVAL RULE — DO NOT CALL THIS TOOL WITHOUT ANTONIO'S EXPLICIT OK.",
      "Same discipline as gmail_send (added 2026-06-03 after an unauthorized send):",
      "  1. Compose the message in chat first — recipient, subject, body verbatim.",
      "  2. STOP and wait for Antonio's explicit approval ('send it', 'go', 'yes ask Claude', or equivalent direct authorization).",
      "  3. A general 'ask Claude about X' is NOT a send approval — show the draft first.",
      "  4. Never call agent_msg_send on the same turn that first proposes the message.",
      "",
      "Behavior:",
      " - Inserts a row in agent_messages with status='pending'.",
      " - On a fresh insert, fires the cron worker immediately (background) so Claude starts within seconds, not minutes.",
      " - If idempotency_key matches an existing row, returns that row WITHOUT firing the worker again (dedup).",
      " - Returns the row id + status. Poll agent_inbox_list with filter='my_replies' to see Claude's reply (typically 30-90s after send).",
      "",
      "Phase 1 is research-only: Claude side cannot mutate, send, or run code in response. Action authorization rail (portal approval) is Phase 2.",
    ].join("\n"),
    {
      recipient: z.enum(PARTY_VALUES).default("claude").describe("Which agent should respond. Default: 'claude'."),
      subject: z.string().min(1).max(500).describe("Short subject line — what is this about."),
      body: z.string().min(1).max(50000).describe("Full request body — the actual question or research task."),
      context_json: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional structured context (account_id, contact_id, related dev_task_id, URLs)."),
      idempotency_key: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional dedup key. If Hermes retries due to a network blip, pass the same key — returns the existing row instead of inserting a duplicate."),
      as_party: z
        .enum(PARTY_VALUES)
        .default("hermes")
        .describe("Which agent is sending. Default 'hermes' (the typical caller). Set 'claude' if Claude Code is replying outside the worker flow."),
    },
    async ({ recipient, subject, body, context_json, idempotency_key, as_party }) => {
      try {
        // Hard validation that the schema-default doesn't accidentally collide.
        // (CHECK constraint exists in DB too; this is a friendlier error.)
        if (as_party === recipient) {
          return {
            content: [{ type: "text" as const, text: `❌ sender (${as_party}) and recipient (${recipient}) must differ.` }],
          }
        }

        // Idempotency: if the caller passed an idempotency_key, look up first.
        if (idempotency_key) {
          const { data: existing } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
            .select("id, status, created_at, reply, replied_at")
            .eq("idempotency_key", idempotency_key)
            .maybeSingle()

          if (existing) {
            return {
              content: [{
                type: "text" as const,
                text: [
                  `✅ Duplicate idempotency_key — returning existing row (no new worker fire).`,
                  `   id=${existing.id}`,
                  `   status=${existing.status}`,
                  `   created_at=${existing.created_at}`,
                  existing.replied_at ? `   replied_at=${existing.replied_at}` : null,
                  existing.reply ? `   (reply present — call agent_inbox_list to read it)` : null,
                ].filter(Boolean).join("\n"),
              }],
            }
          }
        }

        // Insert the row.
        const { data, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
          .insert({
            sender: as_party,
            recipient,
            subject,
            body,
            context_json: context_json ?? {},
            idempotency_key: idempotency_key ?? null,
            status: "pending",
          })
          .select("id, status, created_at")
          .single()

        if (error) {
          // 23505 = unique_violation — covers an idempotency_key race.
          if ((error as { code?: string }).code === "23505") {
            return {
              content: [{
                type: "text" as const,
                text: `❌ Insert race on idempotency_key — call agent_msg_send again with no idempotency_key to retry, or call agent_inbox_list to check if the original is present.`,
              }],
            }
          }
          throw error
        }

        if (!data) throw new Error("Insert succeeded but no row returned.")

        // Trigger the worker now — awaited (3s-bounded) so the request reliably
        // leaves this function; the worker then runs server-side. Cron is the net.
        await fireDirectTrigger(data.id)

        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Message queued (Phase 1 research rail).`,
              `   id=${data.id}`,
              `   sender=${as_party} → recipient=${recipient}`,
              `   status=${data.status}`,
              `   created_at=${data.created_at}`,
              "",
              `Worker triggered directly. Cron (every 5 min) is a fallback if the direct trigger missed.`,
              `Poll agent_inbox_list({ as_party: '${as_party}', filter: 'my_replies' }) to read Claude's reply (typically 30-90s).`,
            ].join("\n"),
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ agent_msg_send error: ${err instanceof Error ? err.message : String(err)}`,
          }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // agent_inbox_list — perspective-relative read
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "agent_inbox_list",
    [
      "List messages in the agent_messages bridge from a specific agent's perspective.",
      "",
      "as_party = the agent doing the reading (caller identifies itself).",
      "filter:",
      "  'inbound_pending' — addressed to me AND status='pending' (work I should do)",
      "  'inbound_all'     — addressed to me, any status",
      "  'my_replies'      — I sent these AND a reply has landed (status='done' AND reply IS NOT NULL)",
      "  'my_sent'         — I sent these, any status",
      "  'all'             — recent rows regardless of perspective (debugging)",
      "",
      "Returns up to `limit` rows newest first.",
    ].join("\n"),
    {
      as_party: z.enum(PARTY_VALUES).describe("Which agent is asking — 'hermes' or 'claude'."),
      filter: z
        .enum(["inbound_pending", "inbound_all", "my_replies", "my_sent", "all"])
        .default("inbound_pending")
        .describe("Perspective filter (see description)."),
      limit: z.number().int().min(1).max(100).default(25).describe("Max rows (default 25)."),
    },
    async ({ as_party, filter, limit }) => {
      try {
        let q = // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
          .select("id, sender, recipient, subject, body, status, reply, replied_at, claimed_at, claimed_by, context_json, idempotency_key, error_text, created_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(limit)

        if (filter === "inbound_pending") {
          q = q.eq("recipient", as_party).eq("status", "pending")
        } else if (filter === "inbound_all") {
          q = q.eq("recipient", as_party)
        } else if (filter === "my_replies") {
          q = q.eq("sender", as_party).eq("status", "done").not("reply", "is", null)
        } else if (filter === "my_sent") {
          q = q.eq("sender", as_party)
        }
        // 'all' = no filter

        const { data, error } = await q
        if (error) throw error

        const rows = (data ?? []) as AgentMessageRow[]
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `📭 No messages (filter=${filter}, as_party=${as_party}).` }] }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ agent_inbox_list error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // agent_inbox_reply — manual fallback (worker is the primary writer)
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "agent_inbox_reply",
    [
      "Write a reply to an agent_messages row by id, then mark it done (or failed).",
      "",
      "This is a manual fallback. The /api/cron/hermes-bridge worker is the primary writer — it handles Hermes → Claude messages automatically (direct-trigger + 5-min cron). Use this tool only when:",
      "  - The worker is unavailable / disabled.",
      "  - You (Claude Code) are responding to a message that the worker missed.",
      "  - You're manually marking a row 'failed' with a diagnostic note.",
      "",
      "Does NOT trigger any side effects (no Telegram push, no email). Just updates the row.",
    ].join("\n"),
    {
      id: z.string().uuid().describe("The agent_messages row id."),
      reply: z.string().min(1).max(200000).describe("Reply text (Markdown OK)."),
      status: z
        .enum(["done", "failed"])
        .default("done")
        .describe("Final status. Default 'done'. Use 'failed' if you couldn't complete the request."),
      error_text: z.string().max(10000).optional().describe("If status='failed', a short error description for the inbox row."),
    },
    async ({ id, reply, status, error_text }) => {
      try {
        const update: Record<string, unknown> = {
          reply,
          replied_at: new Date().toISOString(),
          status,
          updated_at: new Date().toISOString(),
        }
        if (status === "failed" && error_text) {
          update.error_text = error_text
        }

        const { data, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
          .update(update)
          .eq("id", id)
          .select("id, status, replied_at")
          .single()

        if (error) throw error
        if (!data) {
          return { content: [{ type: "text" as const, text: `❌ Row ${id} not found.` }] }
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ Reply saved on ${data.id} (status=${data.status}, replied_at=${data.replied_at}).`,
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ agent_inbox_reply error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )
}
