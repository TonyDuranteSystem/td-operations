/**
 * Agent Threads — Hermes ↔ Claude bridge (Phase C: thread intelligence)
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase C
 *
 * Exposes the durable thread memory (thread_summaries) to MCP callers so Hermes
 * can reference a past investigation instead of re-deriving it:
 *   "remember the tax-return mismatch thread?" → thread_search('tax return mismatch').
 *
 *   thread_search — search resolved/open thread summaries by free text, with
 *                   optional thread_type and tags filters. READ-ONLY.
 *
 * Registered in app/api/[transport]/route.ts via registerAgentThreadTools(server).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { searchThreads } from "@/lib/ai-agent/thread-summaries"
import { THREAD_TYPES } from "@/lib/ai-agent/thread-routing"

export function registerAgentThreadTools(server: McpServer) {
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
