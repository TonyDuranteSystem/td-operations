/**
 * Agent Threads — Hermes ↔ Claude bridge (Phase C: thread intelligence)
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase C
 *
 * Exposes the durable thread memory (thread_summaries) to MCP callers so Hermes
 * can start and reference conversation threads instead of re-deriving them:
 *   "remember the tax-return mismatch thread?" → thread_search('tax return mismatch').
 *
 *   thread_create — start a new typed conversation thread (WP2). Hermes calls
 *                   this first, then tags agent_msg_send with the returned
 *                   thread_id so the worker gets prior-turn context + a tool
 *                   surface filtered by the thread type.
 *   thread_search — search resolved/open thread summaries by free text, with
 *                   optional thread_type and tags filters. READ-ONLY.
 *
 * Registered in app/api/[transport]/route.ts via registerAgentThreadTools(server).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { randomUUID } from "crypto"
import { searchThreads, createThreadSummary } from "@/lib/ai-agent/thread-summaries"
import { THREAD_TYPES } from "@/lib/ai-agent/thread-routing"
import { WORKER_PROMPT_VERSION } from "@/lib/ai-agent/worker-tools"

export function registerAgentThreadTools(server: McpServer) {
  // ═══════════════════════════════════════════════════════════════════════════
  // thread_create — start a new typed conversation thread (WP2).
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "thread_create",
    [
      "Start a new Hermes ↔ Claude conversation thread (WP2). Call this BEFORE the first agent_msg_send of an investigation, then pass the returned thread_id to every agent_msg_send in that conversation so the worker:",
      "  - gets the prior turns of the thread as context (multi-turn memory),",
      "  - is handed a tool surface FILTERED by the thread type, and",
      "  - records a durable, searchable summary (thread_summaries) when it resolves.",
      "",
      "type — the kind of conversation; this narrows the worker's tools and shapes its output:",
      "  investigation   — general research; full read tools.",
      "  action_request  — Antonio wants something done; worker lays out the steps (it cannot act).",
      "  bug_report      — codebase + CRM read tools; output as Summary / Repro / Root cause (file:line) / Fix.",
      "  client_audit    — CRM read tools ONLY; client-facing review.",
      "  internal_ops    — codebase + KB/SOP only; NO client data.",
      "",
      "title (optional) — short human label for the thread.",
      "account_id / contact_id (optional) — the client this thread concerns; recorded on the thread so it's searchable later.",
      "",
      "Returns { thread_id, type, title }. thread_create itself runs nothing — it only opens the thread. READ/WRITE on thread memory only; no client mutation.",
    ].join("\n"),
    {
      type: z.enum(THREAD_TYPES).describe(`Thread type — one of: ${THREAD_TYPES.join(", ")}.`),
      title: z.string().max(300).optional().describe("Short human-readable thread title."),
      account_id: z.string().uuid().optional().describe("Account (company) this thread concerns."),
      contact_id: z.string().uuid().optional().describe("Contact (person) this thread concerns."),
    },
    async ({ type, title, account_id, contact_id }) => {
      try {
        const threadId = randomUUID()
        // account_id + contact_id both land in accounts_affected — the only
        // affected-entities array on thread_summaries (no separate contacts col).
        const accountsAffected = [account_id, contact_id].filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )

        const row = await createThreadSummary(
          threadId,
          type,
          title ?? null,
          WORKER_PROMPT_VERSION,
          accountsAffected.length > 0 ? accountsAffected : null,
        )

        if (!row) {
          return {
            content: [{ type: "text" as const, text: `❌ thread_create failed: could not create thread row.` }],
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              { thread_id: row.thread_id, type: row.thread_type, title: row.title },
              null,
              2,
            ),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ thread_create error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════
  // thread_search — search the bridge's durable thread memory. READ-ONLY.
  // ═══════════════════════════════════════════════════════════════════════════
  server.tool(
    "thread_search",
    [
      "Search the Hermes ↔ Claude bridge's thread memory (Phase C). Each result is a past or in-progress conversation thread the worker recorded — its type, title, outcome, what it touched, and a one-paragraph summary.",
      "",
      "Use it to reference a prior investigation instead of re-deriving it (e.g. 'the tax-return mismatch thread').",
      "",
      "query: free text matched against title, type, tags, affected account ids, outcome, and summary (case-insensitive substring). Empty query lists the most recent threads.",
      `type (optional): restrict to one thread type — one of: ${THREAD_TYPES.join(", ")}.`,
      "tags (optional): require ALL listed tags to be present.",
      "",
      "Returns up to `limit` matches, newest first. READ-ONLY — never writes anything.",
    ].join("\n"),
    {
      query: z.string().default("").describe("Free-text search. Empty lists recent threads."),
      type: z.enum(THREAD_TYPES).optional().describe("Restrict to one thread_type."),
      tags: z.array(z.string()).optional().describe("Require ALL of these tags."),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results (default 20)."),
    },
    async ({ query, type, tags, limit }) => {
      try {
        const { rows, scanned, truncated } = await searchThreads(query, { type, tags, limit })

        if (rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `📭 No threads matched${query ? ` "${query}"` : ""}${type ? ` (type=${type})` : ""}.`,
            }],
          }
        }

        const header = truncated
          ? `⚠️ Searched the ${scanned} most-recent threads (cap hit) — older threads not scanned. Showing ${rows.length}:`
          : `Found ${rows.length} thread(s):`

        return {
          content: [{ type: "text" as const, text: `${header}\n${JSON.stringify(rows, null, 2)}` }],
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `❌ thread_search error: ${err instanceof Error ? err.message : String(err)}` }],
        }
      }
    },
  )
}
