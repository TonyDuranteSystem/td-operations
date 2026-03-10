/**
 * Deadline Tools — Search and track compliance deadlines (tax filings, annual reports, RA renewals).
 * 477+ records of filing deadlines with status tracking.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerDeadlineTools(server: McpServer) {

  // ═══════════════════════════════════════
  // deadline_search
  // ═══════════════════════════════════════
  server.tool(
    "deadline_search",
    "Search compliance deadlines by type, status, date range, state, account, or assignee. Returns deadline type, due date, status (Pending/Filed/Overdue/Blocked), account link, and notes. Use deadline_upcoming for a quick view of what's due soon.",
    {
      deadline_type: z.string().optional().describe("Deadline type (e.g., Annual Report, RA Renewal, Tax Extension, Tax Filing)"),
      status: z.string().optional().describe("Status: Pending, Filed, Overdue, Blocked"),
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      state: z.string().optional().describe("State filter (e.g., Wyoming, Delaware, Florida)"),
      assigned_to: z.string().optional().describe("Assignee name"),
      year: z.number().optional().describe("Deadline year"),
      due_from: z.string().optional().describe("Due date from (YYYY-MM-DD)"),
      due_to: z.string().optional().describe("Due date to (YYYY-MM-DD)"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ deadline_type, status, account_id, state, assigned_to, year, due_from, due_to, limit }) => {
      try {
        let q = supabaseAdmin
          .from("deadlines")
          .select("*, accounts(company_name)")
          .order("due_date", { ascending: true })
          .limit(Math.min(limit || 50, 200))

        if (deadline_type) q = q.ilike("deadline_type", `%${deadline_type}%`)
        if (status) q = q.eq("status", status)
        if (account_id) q = q.eq("account_id", account_id)
        if (state) q = q.eq("state", state)
        if (assigned_to) q = q.ilike("assigned_to", `%${assigned_to}%`)
        if (year) q = q.eq("year", year)
        if (due_from) q = q.gte("due_date", due_from)
        if (due_to) q = q.lte("due_date", due_to)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No deadlines found." }] }
        }

        const today = new Date().toISOString().slice(0, 10)
        const lines: string[] = [`📅 Deadlines (${data.length})`, ""]

        for (const d of data) {
          const acct = d.accounts as { company_name?: string } | null
          const company = acct?.company_name || "Unknown"
          const isPast = d.due_date < today && d.status !== "Filed"
          const icon = d.status === "Filed" ? "🟢" : isPast ? "🔴" : d.status === "Blocked" ? "🟠" : "🟡"
          const blocked = d.blocked_reason ? ` [BLOCKED: ${d.blocked_reason}]` : ""

          lines.push(`${icon} ${company} — ${d.deadline_type}${blocked}`)
          lines.push(`   Due: ${d.due_date} | Status: ${d.status} | ${d.state || "—"}`)
          if (d.filed_date) lines.push(`   Filed: ${d.filed_date}${d.confirmation_number ? ` (#${d.confirmation_number})` : ""}`)
          if (d.assigned_to) lines.push(`   Assigned: ${d.assigned_to}`)
          if (d.notes) lines.push(`   Notes: ${d.notes}`)
          lines.push(`   ID: ${d.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // deadline_upcoming
  // ═══════════════════════════════════════
  server.tool(
    "deadline_upcoming",
    "PREFERRED tool for deadline overviews — use this ONE tool instead of multiple deadline_search calls. Show upcoming and overdue deadlines in a visual dashboard. Color-coded: 🔴 overdue, 🟠 due within 7 days, 🟡 due within 30 days. Display results as markdown tables directly in chat — NEVER create files (docx/pdf/xlsx). Use for daily briefings.",
    {
      days_ahead: z.number().optional().default(30).describe("Show deadlines within N days from today (default 30)"),
      assigned_to: z.string().optional().describe("Filter by assignee"),
      state: z.string().optional().describe("Filter by state"),
    },
    async ({ days_ahead, assigned_to, state }) => {
      try {
        const today = new Date()
        const todayStr = today.toISOString().slice(0, 10)
        const futureDate = new Date(today.getTime() + (days_ahead || 30) * 24 * 60 * 60 * 1000)
        const futureStr = futureDate.toISOString().slice(0, 10)

        // Get unfiled deadlines up to the future date (and all overdue)
        let q = supabaseAdmin
          .from("deadlines")
          .select("*, accounts(company_name)")
          .neq("status", "Filed")
          .lte("due_date", futureStr)
          .order("due_date", { ascending: true })
          .limit(200)

        if (assigned_to) q = q.ilike("assigned_to", `%${assigned_to}%`)
        if (state) q = q.eq("state", state)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: `✅ No pending deadlines in the next ${days_ahead} days.` }] }
        }

        // Categorize
        const overdue = data.filter(d => d.due_date < todayStr)
        const urgent = data.filter(d => {
          const daysUntil = Math.ceil((new Date(d.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
          return daysUntil >= 0 && daysUntil <= 7
        })
        const upcoming = data.filter(d => {
          const daysUntil = Math.ceil((new Date(d.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
          return daysUntil > 7
        })

        const lines: string[] = [
          `═══════════════════════════════════════════════`,
          `  📅 DEADLINE DASHBOARD — Next ${days_ahead} days`,
          `═══════════════════════════════════════════════`,
          "",
        ]

        // Overdue section
        if (overdue.length > 0) {
          lines.push(`  🔴 OVERDUE (${overdue.length})`)
          lines.push(`  ─────────────────────────────────────`)

          // Group by type
          const byType: Record<string, typeof overdue> = {}
          for (const d of overdue) {
            const t = d.deadline_type || "Other"
            if (!byType[t]) byType[t] = []
            byType[t].push(d)
          }

          for (const [type, items] of Object.entries(byType)) {
            lines.push(`  ${type} (${items.length}):`)
            for (const d of items) {
              const acct = d.accounts as { company_name?: string } | null
              const daysLate = Math.ceil((today.getTime() - new Date(d.due_date).getTime()) / (1000 * 60 * 60 * 24))
              lines.push(`     🔴 ${acct?.company_name || "?"} — ${daysLate}d late (due ${d.due_date})`)
            }
          }
          lines.push("")
        }

        // Urgent section (7 days)
        if (urgent.length > 0) {
          lines.push(`  🟠 DUE THIS WEEK (${urgent.length})`)
          lines.push(`  ─────────────────────────────────────`)
          for (const d of urgent) {
            const acct = d.accounts as { company_name?: string } | null
            const daysUntil = Math.ceil((new Date(d.due_date).getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
            const dayLabel = daysUntil === 0 ? "TODAY" : daysUntil === 1 ? "TOMORROW" : `${daysUntil}d`
            lines.push(`     🟠 ${acct?.company_name || "?"} — ${d.deadline_type} (${dayLabel}, ${d.due_date})`)
          }
          lines.push("")
        }

        // Upcoming section
        if (upcoming.length > 0) {
          lines.push(`  🟡 UPCOMING (${upcoming.length})`)
          lines.push(`  ─────────────────────────────────────`)
          // Group by type with counts
          const byType: Record<string, number> = {}
          for (const d of upcoming) {
            const t = d.deadline_type || "Other"
            byType[t] = (byType[t] || 0) + 1
          }
          for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
            lines.push(`     ${type} ${"·".repeat(Math.max(1, 30 - type.length))} ${count}`)
          }
          lines.push("")
        }

        // Summary
        lines.push(`  ─────────────────────────────────────`)
        lines.push(`  Total: ${data.length} pending | 🔴 ${overdue.length} overdue | 🟠 ${urgent.length} this week | 🟡 ${upcoming.length} later`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // deadline_update
  // ═══════════════════════════════════════
  server.tool(
    "deadline_update",
    "Update a deadline's status, filed_date, confirmation_number, blocked_reason, assigned_to, or notes. Use deadline_search first to find the ID.",
    {
      id: z.string().uuid().describe("Deadline UUID (from deadline_search)"),
      updates: z.record(z.string(), z.any()).describe("Fields to update (e.g., {status: 'Filed', filed_date: '2026-03-09', confirmation_number: 'ABC123'})"),
    },
    async ({ id, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("deadlines")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("id, deadline_type, status, due_date, accounts(company_name)")
          .single()

        if (error) throw new Error(error.message)
        const acct = data.accounts as { company_name?: string } | null

        return { content: [{ type: "text" as const, text: `✅ Deadline updated: ${acct?.company_name || "?"} — ${data.deadline_type}\nStatus: ${data.status} | Due: ${data.due_date}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
