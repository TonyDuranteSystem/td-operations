/**
 * Circleback MCP Tools
 * Query call summaries received via webhook from Circleback.
 * Data stored in call_summaries table.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export function registerCirclebackTools(server: McpServer) {

  // ═══════════════════════════════════════
  // cb_list_calls
  // ═══════════════════════════════════════
  server.tool(
    "cb_list_calls",
    "List call summaries from Circleback. Shows meeting name, date, duration, attendee count, and whether it's linked to a lead or account. Filter by lead_id, account_id, or date range. Use cb_get_call with the call ID for full notes, action items, and transcript.",
    {
      lead_id: z.string().uuid().optional().describe("Filter by linked lead UUID"),
      account_id: z.string().uuid().optional().describe("Filter by linked CRM account UUID"),
      min_date: z.string().optional().describe("Show calls after this date (YYYY-MM-DD)"),
      max_date: z.string().optional().describe("Show calls before this date (YYYY-MM-DD)"),
      limit: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ lead_id, account_id, min_date, max_date, limit }) => {
      try {
        let query = supabase
          .from("call_summaries")
          .select("id, circleback_id, meeting_name, duration_seconds, attendees, lead_id, account_id, tags, created_at")
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (lead_id) query = query.eq("lead_id", lead_id)
        if (account_id) query = query.eq("account_id", account_id)
        if (min_date) query = query.gte("created_at", `${min_date}T00:00:00`)
        if (max_date) query = query.lte("created_at", `${max_date}T23:59:59`)

        const { data, error } = await query

        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No call summaries found." }] }
        }

        const lines: string[] = [`Call Summaries (${data.length})`, ""]

        for (const call of data) {
          const date = new Date(call.created_at).toLocaleDateString("en-US", {
            weekday: "short", month: "short", day: "numeric", year: "numeric"
          })
          const mins = call.duration_seconds ? Math.round(call.duration_seconds / 60) : 0
          const attendeeCount = Array.isArray(call.attendees) ? call.attendees.length : 0
          const tags = Array.isArray(call.tags) && call.tags.length > 0 ? ` [${call.tags.join(", ")}]` : ""

          lines.push(`${call.meeting_name || "Untitled Call"}${tags}`)
          lines.push(`   Date: ${date} | Duration: ${mins} min | Attendees: ${attendeeCount}`)
          if (call.lead_id) lines.push(`   Lead: ${call.lead_id}`)
          if (call.account_id) lines.push(`   Account: ${call.account_id}`)
          lines.push(`   ID: ${call.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error listing calls: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // cb_get_call
  // ═══════════════════════════════════════
  server.tool(
    "cb_get_call",
    "Get full call summary by ID — includes meeting notes, action items, transcript, attendee details, and linked lead/account. Use cb_list_calls first to find the call ID.",
    {
      id: z.string().uuid().describe("Call summary UUID (from cb_list_calls)"),
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabase
          .from("call_summaries")
          .select("*")
          .eq("id", id)
          .single()

        if (error || !data) {
          return { content: [{ type: "text" as const, text: `Call not found: ${id}` }] }
        }

        const date = new Date(data.created_at).toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", year: "numeric"
        })
        const mins = data.duration_seconds ? Math.round(data.duration_seconds / 60) : 0

        const lines: string[] = [
          `${data.meeting_name || "Untitled Call"}`,
          "",
          `Date: ${date}`,
          `Duration: ${mins} min`,
        ]

        if (data.meeting_url) lines.push(`Meeting URL: ${data.meeting_url}`)
        if (data.recording_url) lines.push(`Recording: ${data.recording_url}`)
        if (data.lead_id) lines.push(`Linked Lead: ${data.lead_id}`)
        if (data.account_id) lines.push(`Linked Account: ${data.account_id}`)
        if (Array.isArray(data.tags) && data.tags.length > 0) lines.push(`Tags: ${data.tags.join(", ")}`)

        // Attendees
        if (Array.isArray(data.attendees) && data.attendees.length > 0) {
          lines.push("")
          lines.push("── Attendees ──")
          for (const a of data.attendees) {
            const name = a.name || a.email || "Unknown"
            const email = a.email ? ` <${a.email}>` : ""
            lines.push(`  ${name}${email}`)
          }
        }

        // Notes
        if (data.notes) {
          lines.push("")
          lines.push("── Notes ──")
          lines.push(typeof data.notes === "string" ? data.notes : JSON.stringify(data.notes, null, 2))
        }

        // Action items
        if (Array.isArray(data.action_items) && data.action_items.length > 0) {
          lines.push("")
          lines.push("── Action Items ──")
          for (const item of data.action_items) {
            const text = typeof item === "string" ? item : item.text || item.description || JSON.stringify(item)
            const assignee = item.assignee ? ` (@${item.assignee})` : ""
            lines.push(`  - ${text}${assignee}`)
          }
        }

        // Transcript (truncate to avoid huge responses)
        if (Array.isArray(data.transcript) && data.transcript.length > 0) {
          lines.push("")
          lines.push("── Transcript ──")
          const maxEntries = 50
          const entries = data.transcript.slice(0, maxEntries)
          for (const entry of entries) {
            const speaker = entry.speaker || entry.name || "?"
            const text = entry.text || entry.content || ""
            lines.push(`  [${speaker}]: ${text}`)
          }
          if (data.transcript.length > maxEntries) {
            lines.push(`  ... (${data.transcript.length - maxEntries} more entries)`)
          }
        }

        lines.push("")
        lines.push(`ID: ${data.id}`)
        if (data.circleback_id) lines.push(`Circleback ID: ${data.circleback_id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // cb_search_calls
  // ═══════════════════════════════════════
  server.tool(
    "cb_search_calls",
    "Search call summaries by text in meeting name or notes. Returns matching calls with snippets. Use cb_get_call for full details.",
    {
      query: z.string().describe("Search text (matches meeting_name and notes, case-insensitive)"),
      limit: z.number().optional().default(15).describe("Max results (default 15)"),
    },
    async ({ query, limit }) => {
      try {
        // Search in meeting_name
        const { data: nameMatches, error: e1 } = await supabase
          .from("call_summaries")
          .select("id, meeting_name, notes, duration_seconds, created_at, lead_id, account_id")
          .ilike("meeting_name", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 15, 50))

        // Search in notes
        const { data: noteMatches, error: e2 } = await supabase
          .from("call_summaries")
          .select("id, meeting_name, notes, duration_seconds, created_at, lead_id, account_id")
          .ilike("notes", `%${query}%`)
          .order("created_at", { ascending: false })
          .limit(Math.min(limit || 15, 50))

        if (e1) throw new Error(e1.message)
        if (e2) throw new Error(e2.message)

        // Merge and deduplicate
        const seen = new Set<string>()
        const results: typeof nameMatches = []
        for (const item of [...(nameMatches || []), ...(noteMatches || [])]) {
          if (!seen.has(item.id)) {
            seen.add(item.id)
            results.push(item)
          }
        }

        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No calls matching "${query}".` }] }
        }

        const lines: string[] = [`Search: "${query}" — ${results.length} result(s)`, ""]

        for (const call of results.slice(0, limit || 15)) {
          const date = new Date(call.created_at).toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric"
          })
          const mins = call.duration_seconds ? Math.round(call.duration_seconds / 60) : 0

          lines.push(`${call.meeting_name || "Untitled"} — ${date} (${mins} min)`)

          // Show snippet from notes if matched there
          if (call.notes && typeof call.notes === "string") {
            const idx = call.notes.toLowerCase().indexOf(query.toLowerCase())
            if (idx >= 0) {
              const start = Math.max(0, idx - 40)
              const end = Math.min(call.notes.length, idx + query.length + 40)
              const snippet = (start > 0 ? "..." : "") + call.notes.slice(start, end) + (end < call.notes.length ? "..." : "")
              lines.push(`   "${snippet}"`)
            }
          }

          lines.push(`   ID: ${call.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Search error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
