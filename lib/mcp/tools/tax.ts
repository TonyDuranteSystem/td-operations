/**
 * Tax Return Tools — Search and track tax returns with visual dashboard.
 * Color-coded status tracking for tax season management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerTaxTools(server: McpServer) {

  // ═══════════════════════════════════════
  // tax_search
  // ═══════════════════════════════════════
  server.tool(
    "tax_search",
    "Search tax returns by year, status, return type, account, or special case flag. Returns company name, return type (1065/1120-S/1040NR), status, deadline, and workflow progress (paid/link_sent/data_received/sent_to_india/extension/india_status). Use tax_tracker for the visual dashboard overview.",
    {
      tax_year: z.number().optional().describe("Tax year (e.g., 2025)"),
      status: z.string().optional().describe("Status: Payment Pending, Paid - Not Started, Activated - Need Link, Link Sent - Awaiting Data, Data Received, Sent to India, Extension Filed, TR Completed - Awaiting Signature, TR Filed, Not Invoiced"),
      return_type: z.string().optional().describe("Return type: 1065, 1120-S, 1040NR"),
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      company_name: z.string().optional().describe("Search by company name"),
      special_case: z.boolean().optional().describe("Filter special cases only"),
      overdue_only: z.boolean().optional().describe("Show only returns past deadline that aren't filed"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ tax_year, status, return_type, account_id, company_name, special_case, overdue_only, limit }) => {
      try {
        let q = supabaseAdmin
          .from("tax_returns")
          .select("*")
          .order("deadline", { ascending: true })
          .limit(Math.min(limit || 50, 200))

        if (tax_year) q = q.eq("tax_year", tax_year)
        if (status) q = q.eq("status", status)
        if (return_type) q = q.eq("return_type", return_type)
        if (account_id) q = q.eq("account_id", account_id)
        if (company_name) q = q.ilike("company_name", `%${company_name}%`)
        if (special_case === true) q = q.eq("special_case", true)
        if (overdue_only) {
          q = q.lt("deadline", new Date().toISOString().slice(0, 10))
            .neq("status", "TR Filed")
            .neq("status", "Extension Filed")
        }

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No tax returns found." }] }
        }

        const statusIcon: Record<string, string> = {
          "Payment Pending": "🔴",
          "Not Invoiced": "🔴",
          "Paid - Not Started": "🟠",
          "Activated - Need Link": "🟠",
          "Link Sent - Awaiting Data": "🟡",
          "Data Received": "🟡",
          "Sent to India": "🔵",
          "Extension Filed": "🔵",
          "TR Completed - Awaiting Signature": "🟣",
          "TR Filed": "🟢",
        }

        const lines: string[] = [`📊 Tax Returns (${data.length})`, ""]

        for (const tr of data) {
          const icon = statusIcon[tr.status] || "⚪"
          const deadline = tr.deadline || "—"
          const ext = tr.extension_filed ? ` → ext: ${tr.extension_deadline || "?"}` : ""
          const special = tr.special_case ? " ⚠️" : ""
          const india = tr.india_status && tr.india_status !== "Not Sent" ? ` | India: ${tr.india_status}` : ""

          lines.push(`${icon} ${tr.company_name}${special}`)
          lines.push(`   ${tr.return_type} ${tr.tax_year} | ${tr.status}${india}`)
          lines.push(`   Deadline: ${deadline}${ext}`)

          // Workflow progress
          const steps = [
            tr.paid ? "✅ Paid" : "⬜ Paid",
            tr.link_sent ? "✅ Link" : "⬜ Link",
            tr.data_received ? "✅ Data" : "⬜ Data",
            tr.sent_to_india ? "✅ India" : "⬜ India",
            tr.extension_filed ? "✅ Ext" : "⬜ Ext",
            tr.status === "TR Filed" ? "✅ Filed" : "⬜ Filed",
          ]
          lines.push(`   ${steps.join(" → ")}`)
          if (tr.notes) lines.push(`   Notes: ${tr.notes}`)
          lines.push(`   ID: ${tr.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_tracker
  // ═══════════════════════════════════════
  server.tool(
    "tax_tracker",
    "PREFERRED tool for tax return overviews — use this ONE tool instead of multiple tax_search calls. Visual tax season dashboard with color-coded progress bars, status counts, and deadline alerts. Display results as markdown tables directly in chat — NEVER create files (docx/pdf/xlsx). Use for daily briefings and season monitoring.",
    {
      tax_year: z.number().optional().describe("Tax year (default: current year)"),
      return_type: z.string().optional().describe("Filter by return type: 1065, 1120-S, 1040NR"),
    },
    async ({ tax_year, return_type }) => {
      try {
        const year = tax_year || new Date().getFullYear()
        const today = new Date().toISOString().slice(0, 10)

        let q = supabaseAdmin
          .from("tax_returns")
          .select("*")
          .eq("tax_year", year)

        if (return_type) q = q.eq("return_type", return_type)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: `No tax returns found for ${year}.` }] }
        }

        // Group by return type
        const byType: Record<string, typeof data> = {}
        for (const tr of data) {
          const rt = tr.return_type || "Unknown"
          if (!byType[rt]) byType[rt] = []
          byType[rt].push(tr)
        }

        // Status categories
        const isActionNeeded = (s: string) => ["Payment Pending", "Not Invoiced", "Paid - Not Started", "Activated - Need Link"].includes(s)
        const isWaiting = (s: string) => ["Link Sent - Awaiting Data"].includes(s)
        const isInProgress = (s: string) => ["Data Received", "Sent to India"].includes(s)
        const isExtended = (s: string) => ["Extension Filed"].includes(s)
        const isNearDone = (s: string) => ["TR Completed - Awaiting Signature"].includes(s)
        const isDone = (s: string) => ["TR Filed"].includes(s)

        const lines: string[] = [
          `═══════════════════════════════════════════════`,
          `  📊 TAX SEASON ${year} — Dashboard`,
          `═══════════════════════════════════════════════`,
          "",
        ]

        for (const [rt, returns] of Object.entries(byType)) {
          const total = returns.length
          const filed = returns.filter(r => isDone(r.status)).length
          const pct = Math.round((filed / total) * 100)

          // Deadline info
          const deadlines = Array.from(new Set(returns.map(r => r.deadline).filter(Boolean)))
          const mainDeadline = deadlines.sort()[0] || "—"
          const overdue = returns.filter(r => r.deadline && r.deadline < today && !isDone(r.status) && !isExtended(r.status))

          // Progress bar (30 chars)
          const filledBlocks = Math.round((filed / total) * 30)
          const bar = "█".repeat(filledBlocks) + "░".repeat(30 - filledBlocks)

          lines.push(`  📄 ${rt}    Deadline: ${mainDeadline}`)
          lines.push(`  ${bar}  ${pct}% (${filed}/${total})`)
          lines.push("")

          // Status breakdown
          const actionNeeded = returns.filter(r => isActionNeeded(r.status))
          const waiting = returns.filter(r => isWaiting(r.status))
          const inProgress = returns.filter(r => isInProgress(r.status))
          const extended = returns.filter(r => isExtended(r.status))
          const nearDone = returns.filter(r => isNearDone(r.status))
          const done = returns.filter(r => isDone(r.status))

          if (actionNeeded.length > 0) {
            lines.push(`  🔴 ACTION NEEDED (${actionNeeded.length})`)
            // Sub-counts by exact status
            const sub: Record<string, number> = {}
            for (const r of actionNeeded) sub[r.status] = (sub[r.status] || 0) + 1
            for (const [s, c] of Object.entries(sub)) {
              lines.push(`     ${s} ${"·".repeat(Math.max(1, 35 - s.length))} ${c}`)
            }
          }

          if (waiting.length > 0) {
            lines.push(`  🟡 WAITING FOR CLIENT (${waiting.length})`)
            const sub: Record<string, number> = {}
            for (const r of waiting) sub[r.status] = (sub[r.status] || 0) + 1
            for (const [s, c] of Object.entries(sub)) {
              lines.push(`     ${s} ${"·".repeat(Math.max(1, 35 - s.length))} ${c}`)
            }
            // Flag overdue waiting
            const waitOverdue = waiting.filter(r => r.link_sent_date && daysSince(r.link_sent_date) > 5)
            if (waitOverdue.length > 0) {
              lines.push(`     ⚠️ ${waitOverdue.length} waiting 5+ days — need follow-up`)
            }
          }

          if (inProgress.length > 0) {
            lines.push(`  🔵 IN PROGRESS (${inProgress.length})`)
            const sub: Record<string, number> = {}
            for (const r of inProgress) sub[r.status] = (sub[r.status] || 0) + 1
            for (const [s, c] of Object.entries(sub)) {
              lines.push(`     ${s} ${"·".repeat(Math.max(1, 35 - s.length))} ${c}`)
            }
            // India status sub-breakdown
            const indiaStatuses: Record<string, number> = {}
            for (const r of inProgress.filter(r => r.india_status)) {
              indiaStatuses[r.india_status] = (indiaStatuses[r.india_status] || 0) + 1
            }
            if (Object.keys(indiaStatuses).length > 0) {
              lines.push(`     India: ${Object.entries(indiaStatuses).map(([s, c]) => `${s}: ${c}`).join(", ")}`)
            }
          }

          if (extended.length > 0) {
            lines.push(`  🔵 EXTENSION FILED (${extended.length})`)
          }

          if (nearDone.length > 0) {
            lines.push(`  🟣 AWAITING SIGNATURE (${nearDone.length})`)
          }

          if (done.length > 0) {
            lines.push(`  🟢 FILED (${done.length})`)
          }

          // Overdue alert
          if (overdue.length > 0) {
            lines.push("")
            lines.push(`  ⚠️ OVERDUE: ${overdue.length} returns past deadline`)
            for (const r of overdue.slice(0, 10)) {
              lines.push(`     🔴 ${r.company_name} — ${r.status} (due: ${r.deadline})`)
            }
          }

          // Special cases
          const specials = returns.filter(r => r.special_case)
          if (specials.length > 0) {
            lines.push(`  ⚠️ Special cases: ${specials.length}`)
          }

          lines.push("")
          lines.push("  ─────────────────────────────────────────")
          lines.push("")
        }

        // Grand total
        const total = data.length
        const totalFiled = data.filter(r => isDone(r.status)).length
        const totalPct = Math.round((totalFiled / total) * 100)
        lines.push(`  TOTAL: ${totalFiled}/${total} filed (${totalPct}%)`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_update
  // ═══════════════════════════════════════
  server.tool(
    "tax_update",
    "Update a tax return's workflow fields — status, dates, india_status, extension, notes. Use tax_search first to find the ID. Common updates: mark as paid, set link_sent_date, update india_status, mark as filed.",
    {
      id: z.string().uuid().describe("Tax return UUID (from tax_search)"),
      updates: z.record(z.string(), z.any()).describe("Fields to update (e.g., {status: 'Data Received', data_received: true, data_received_date: '2026-03-09'})"),
    },
    async ({ id, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("tax_returns")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("id, company_name, return_type, tax_year, status")
          .single()

        if (error) throw new Error(error.message)

        return { content: [{ type: "text" as const, text: `✅ Tax return updated: ${data.company_name} (${data.return_type} ${data.tax_year})\nStatus: ${data.status}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  const now = new Date()
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}
