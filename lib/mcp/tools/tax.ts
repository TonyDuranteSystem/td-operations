/**
 * Tax Return Tools — Search and track tax returns with visual dashboard.
 * Color-coded status tracking for tax season management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { listFolder, findTaxFolder, findOrCreateYearFolder, downloadFileBinary } from "@/lib/google-drive"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"

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
      contact_id: z.string().uuid().optional().describe("Filter by contact UUID (for individual tax returns without account)"),
      company_name: z.string().optional().describe("Search by company name"),
      special_case: z.boolean().optional().describe("Filter special cases only"),
      overdue_only: z.boolean().optional().describe("Show only returns past deadline that aren't filed"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ tax_year, status, return_type, account_id, contact_id, company_name, special_case, overdue_only, limit }) => {
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
        if (contact_id) q = q.eq("contact_id", contact_id)
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

  // ═══════════════════════════════════════
  // tax_form_create
  // ═══════════════════════════════════════
  server.tool(
    "tax_form_create",
    "Create a tax data collection form for a client. Pre-fills owner info from contacts and LLC info from accounts. Returns the form URL (${APP_BASE_URL}/tax-form/{token}). Supported entity_type: SMLLC (Form 1120/5472), MMLLC (Form 1065), Corp (Form 1120). Admin preview: append ?preview=td to the form URL to bypass the email gate. ALWAYS provide the admin preview link after creating a form so Antonio can review it before sending. Use gmail_send to send the link to the client.",
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID (auto-detects primary contact if omitted)"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      entity_type: z.enum(["SMLLC", "MMLLC", "Corp"]).describe("Entity type: SMLLC, MMLLC, or Corp"),
      language: z.enum(["en", "it"]).optional().describe("Form language (auto-detected from contact.language if omitted)"),
    },
    async ({ account_id, contact_id, tax_year, entity_type, language }) => {
      try {
        // 1. Get account data
        const { data: account, error: accErr } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, formation_date, state_of_formation, physical_address, entity_type, drive_folder_id")
          .eq("id", account_id)
          .single()
        if (accErr || !account) throw new Error(`Account not found: ${accErr?.message || account_id}`)

        // 2. Get contact (primary contact if not specified)
        let contactQuery = supabaseAdmin.from("contacts").select("id, first_name, last_name, email, phone, citizenship, residency, itin_number, language, full_name")
        if (contact_id) {
          contactQuery = contactQuery.eq("id", contact_id)
        } else {
          // Find primary contact via account_contacts
          const { data: ac } = await supabaseAdmin
            .from("account_contacts")
            .select("contact_id")
            .eq("account_id", account_id)
            .limit(1)
            .single()
          if (ac) {
            contactQuery = contactQuery.eq("id", ac.contact_id)
          } else {
            throw new Error("No contact found for this account. Provide contact_id manually.")
          }
        }
        const { data: contact, error: conErr } = await contactQuery.single()
        if (conErr || !contact) throw new Error(`Contact not found: ${conErr?.message}`)

        // 3. Check documents on file (DB first, then Drive fallback)
        const { data: docs } = await supabaseAdmin
          .from("documents")
          .select("document_type_name")
          .eq("account_id", account_id)
          .in("document_type_name", ["Articles of Organization", "EIN Letter", "EIN Confirmation Letter"])
        let hasArticles = docs?.some(d => d.document_type_name === "Articles of Organization") || false
        let hasEin = docs?.some(d => ["EIN Letter", "EIN Confirmation Letter"].includes(d.document_type_name)) || false

        // Drive fallback: list client's folder if docs not found in DB
        if ((!hasArticles || !hasEin) && account.drive_folder_id) {
          try {
            const driveResults = await listFolder(account.drive_folder_id, 100)
            const files = (driveResults as { files?: { name: string }[] })?.files || []
            for (const f of files) {
              const name = f.name.toLowerCase()
              if (!hasArticles && (name.includes("articles") || name.includes("atto costitutivo"))) {
                hasArticles = true
              }
              if (!hasEin && (name.includes("ein") || name.includes("cp 575") || name.includes("cp575"))) {
                hasEin = true
              }
            }
          } catch {
            // Drive search failed — continue with DB-only results
          }
        }

        // 4. Build prefilled data
        const prefilled: Record<string, unknown> = {
          // Owner (from contacts)
          owner_first_name: contact.first_name || "",
          owner_last_name: contact.last_name || "",
          owner_email: contact.email || "",
          owner_phone: contact.phone || "",
          owner_country: contact.residency || "",
          owner_tax_residency: contact.citizenship || "",
          // LLC (from accounts)
          llc_name: account.company_name || "",
          ein_number: account.ein_number || "",
          date_of_incorporation: account.formation_date || "",
          state_of_incorporation: account.state_of_formation || "",
        }

        // 5. Generate token
        const slug = (account.company_name || "form")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30)
        const token = `${slug}-${tax_year}`

        // 6. Check for existing submission
        const { data: existing } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("id, token, status, access_code")
          .eq("token", token)
          .maybeSingle()
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Form already exists for ${account.company_name} ${tax_year}\nToken: ${existing.token}\nStatus: ${existing.status}\nURL: ${APP_BASE_URL}/tax-form/${existing.token}/${existing.access_code}`,
            }],
          }
        }

        // 7. Link to tax_returns record (if exists)
        const { data: taxReturn } = await supabaseAdmin
          .from("tax_returns")
          .select("id")
          .eq("account_id", account_id)
          .eq("tax_year", tax_year)
          .maybeSingle()

        // 8. Determine language
        const formLang = language || (contact.language === "it" ? "it" : "en")

        // 9. Insert
        const { data: submission, error: insErr } = await supabaseAdmin
          .from("tax_return_submissions")
          .insert({
            token,
            account_id,
            contact_id: contact.id,
            tax_year,
            entity_type,
            language: formLang,
            prefilled_data: prefilled,
            has_articles_on_file: hasArticles,
            has_ein_letter_on_file: hasEin,
            tax_return_id: taxReturn?.id || null,
            status: "pending",
          })
          .select("id, token, access_code")
          .single()
        if (insErr) throw new Error(insErr.message)

        const url = `${APP_BASE_URL}/tax-form/${token}/${submission.access_code}`
        const adminPreviewUrl = `${url}?preview=td`
        return {
          content: [{
            type: "text" as const,
            text: [
              `✅ Tax form created for ${account.company_name}`,
              `   Entity: ${entity_type} | Year: ${tax_year} | Lang: ${formLang}`,
              `   Contact: ${contact.full_name} (${contact.email})`,
              `   Docs: Articles ${hasArticles ? "✅" : "❌"} | EIN ${hasEin ? "✅" : "❌"}`,
              `   Token: ${token}`,
              `   ID: ${submission.id}`,
              "",
              `   👁️ Admin Preview: ${adminPreviewUrl}`,
              `   🔗 Client URL: ${url}`,
              "",
              `⚠️ Review the admin preview FIRST, then send the client URL via gmail_send`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_form_get
  // ═══════════════════════════════════════
  server.tool(
    "tax_form_get",
    "Get a tax data collection form by token or by account_id + tax_year. Returns prefilled data, submitted data, status, timestamps, and changed fields. Use this to check form status or review client submissions.",
    {
      token: z.string().optional().describe("Form token (e.g., 'df-commerce-2025')"),
      account_id: z.string().uuid().optional().describe("Account UUID (use with tax_year)"),
      tax_year: z.number().optional().describe("Tax year (use with account_id)"),
    },
    async ({ token, account_id, tax_year }) => {
      try {
        let q = supabaseAdmin.from("tax_return_submissions").select("*")
        if (token) {
          q = q.eq("token", token)
        } else if (account_id && tax_year) {
          q = q.eq("account_id", account_id).eq("tax_year", tax_year)
        } else {
          return { content: [{ type: "text" as const, text: "Provide either token OR account_id + tax_year." }] }
        }

        const { data, error } = await q.maybeSingle()
        if (error) throw new Error(error.message)
        if (!data) return { content: [{ type: "text" as const, text: "No form found." }] }

        // Get account name
        let companyName = ""
        if (data.account_id) {
          const { data: acc } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", data.account_id)
            .single()
          companyName = acc?.company_name || ""
        }

        const changedCount = data.changed_fields ? Object.keys(data.changed_fields).length : 0

        const lines = [
          `📋 Tax Form: ${data.token}`,
          `   Company: ${companyName}`,
          `   Entity: ${data.entity_type} | Year: ${data.tax_year} | Lang: ${data.language}`,
          `   Status: ${data.status}`,
          `   Docs: Articles ${data.has_articles_on_file ? "✅" : "❌"} | EIN ${data.has_ein_letter_on_file ? "✅" : "❌"}`,
          `   Confirmation: ${data.confirmation_accepted ? "✅ Accepted" : "⬜ Not accepted"}`,
          "",
          `   Created: ${data.created_at}`,
          data.sent_at ? `   Sent: ${data.sent_at}` : null,
          data.opened_at ? `   Opened: ${data.opened_at}` : null,
          data.completed_at ? `   Completed: ${data.completed_at}` : null,
          data.reviewed_at ? `   Reviewed: ${data.reviewed_at} by ${data.reviewed_by}` : null,
          "",
          `   Changed fields: ${changedCount}`,
        ].filter(Boolean)

        if (changedCount > 0) {
          lines.push("")
          lines.push("   🔄 Changes detected:")
          for (const [key, val] of Object.entries(data.changed_fields as Record<string, { old: unknown; new: unknown }>)) {
            lines.push(`      ${key}: "${val.old}" → "${val.new}"`)
          }
        }

        if (data.upload_paths && (data.upload_paths as string[]).length > 0) {
          lines.push("")
          lines.push(`   📎 Uploads: ${(data.upload_paths as string[]).length} files`)
        }

        const formUrl = `${APP_BASE_URL}/tax-form/${data.token}/${data.access_code}`
        const adminPreviewUrl = `${formUrl}?preview=td`

        lines.push("")
        lines.push(`   👁️ Admin Preview: ${adminPreviewUrl}`)
        lines.push(`   🔗 Client URL: ${formUrl}`)
        lines.push(`   ID: ${data.id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_form_review
  // ═══════════════════════════════════════
  server.tool(
    "tax_form_review",
    "Review a completed tax form submission. Shows diff table of changed fields (pre-filled vs submitted). If apply_changes=true, updates CRM records (contacts/accounts) with client corrections and marks the tax return as Data Received. Always run without apply_changes first to review, then confirm with Antonio before applying.",
    {
      token: z.string().describe("Form token to review"),
      apply_changes: z.boolean().optional().default(false).describe("If true, apply changed fields to CRM and update tax_return status"),
    },
    async ({ token, apply_changes }) => {
      try {
        const { data: sub, error } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("*")
          .eq("token", token)
          .single()
        if (error || !sub) throw new Error(`Form not found: ${token}`)

        if (sub.status !== "completed") {
          return { content: [{ type: "text" as const, text: `⚠️ Form status is "${sub.status}" — not yet completed by client.` }] }
        }

        const changes = sub.changed_fields as Record<string, { old: unknown; new: unknown }> | null
        const changeCount = changes ? Object.keys(changes).length : 0

        // Get company name
        let companyName = token
        if (sub.account_id) {
          const { data: acc } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", sub.account_id)
            .single()
          companyName = acc?.company_name || token
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  📋 FORM REVIEW: ${companyName}`,
          `  ${sub.entity_type} | ${sub.tax_year} | ${sub.language}`,
          `═══════════════════════════════════════`,
          "",
        ]

        if (changeCount === 0) {
          lines.push("✅ No changes detected — all pre-filled data was confirmed by client.")
        } else {
          lines.push(`🔄 ${changeCount} field(s) changed by client:`)
          lines.push("")
          lines.push("| Field | Pre-filled | Client Value |")
          lines.push("|-------|-----------|-------------|")
          for (const [key, val] of Object.entries(changes!)) {
            const oldVal = val.old === null || val.old === "" ? "(empty)" : String(val.old)
            const newVal = String(val.new)
            lines.push(`| ${key} | ${oldVal} | ${newVal} |`)
          }
        }

        // Upload info
        const uploads = sub.upload_paths as string[] | null
        if (uploads && uploads.length > 0) {
          lines.push("")
          lines.push(`📎 ${uploads.length} file(s) uploaded:`)
          for (const path of uploads) {
            lines.push(`   • ${path}`)
          }
        }

        lines.push("")
        lines.push(`Submitted: ${sub.completed_at}`)
        lines.push(`Confirmation: ${sub.confirmation_accepted ? "✅ Accepted" : "❌ Not accepted"}`)

        if (apply_changes) {
          lines.push("")
          lines.push("───────────────────────────────────")
          lines.push("ENQUEUING BACKGROUND JOB...")
          lines.push("")

          // Enqueue async job for CRM updates
          const { enqueueJob } = await import("@/lib/jobs/queue")
          const { id: jobId } = await enqueueJob({
            job_type: "tax_form_setup",
            payload: {
              token: sub.token,
              submission_id: sub.id,
              contact_id: sub.contact_id || null,
              account_id: sub.account_id || null,
              tax_return_id: sub.tax_return_id || null,
              changed_fields: changes,
            },
            priority: 1,
            max_attempts: 3,
            account_id: sub.account_id || undefined,
            related_entity_type: "tax_return_submission",
            related_entity_id: sub.id,
            created_by: "claude",
          })

          lines.push(`✅ Background job enqueued: ${jobId}`)
          lines.push(`   Steps: Contact update → Account update → Tax return → Data Received → Form → reviewed`)
          lines.push("")
          lines.push(`➡️ Check progress: job_status('${jobId}')`)

          // Save form data + uploads to Drive
          if (sub.account_id) {
            try {
              const { data: acc } = await supabaseAdmin
                .from("accounts")
                .select("drive_folder_id")
                .eq("id", sub.account_id)
                .single()
              if (acc?.drive_folder_id) {
                const { saveFormToDrive } = await import("@/lib/form-to-drive")
                const submitted = sub.submitted_data as Record<string, unknown> || {}
                const driveResult = await saveFormToDrive(
                  "tax_return",
                  submitted,
                  (sub.upload_paths as string[]) || [],
                  acc.drive_folder_id,
                  { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName, year: sub.tax_year }
                )
                if (driveResult.summaryFileId) lines.push(`✅ Tax data summary saved to Drive (${driveResult.summaryFileId})`)
                if (driveResult.copied.length > 0) lines.push(`✅ ${driveResult.copied.length} file(s) copied to Drive`)
                if (driveResult.failed.length > 0) lines.push(`⚠️ ${driveResult.failed.length} file(s) failed to copy`)
                if (driveResult.errors.length > 0) lines.push(`⚠️ Drive errors: ${driveResult.errors.join(", ")}`)
              } else {
                lines.push("⚠️ No Drive folder — data not saved to Drive")
              }
            } catch (e) {
              lines.push(`⚠️ Drive save failed: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_extension_list
  // ═══════════════════════════════════════
  server.tool(
    "tax_extension_list",
    "Generate the list of ALL clients needing a tax extension for a given tax year. Returns CSV-ready data: company name, EIN, entity type, state, return type. Use this in February to prepare the bulk extension list for the India team. Optionally sends the list via email to a specified address.",
    {
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      send_to_email: z.string().optional().describe("If provided, sends the extension list to this email address"),
    },
    async ({ tax_year, send_to_email }) => {
      try {
        // Get all tax returns for this year that don't have extension filed
        const { data: returns, error } = await supabaseAdmin
          .from("tax_returns")
          .select("id, account_id, contact_id, return_type, status, extension_filed, extension_submission_id")
          .eq("tax_year", tax_year)
          .order("return_type")

        if (error) throw new Error(error.message)
        if (!returns || returns.length === 0) {
          return { content: [{ type: "text" as const, text: `No tax returns found for ${tax_year}.` }] }
        }

        // Get account details for each
        const accountIds = Array.from(new Set(returns.filter(r => r.account_id).map(r => r.account_id!)))
        const { data: accounts } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, entity_type, state_of_formation")
          .in("id", accountIds)

        const accMap = new Map((accounts || []).map(a => [a.id, a]))

        // Build the list
        const needExtension = returns.filter(r => !r.extension_filed)
        const alreadyFiled = returns.filter(r => r.extension_filed)

        const csvLines = ["Company Name,EIN,Entity Type,State,Return Type,Tax Return ID"]
        const tableLines: string[] = []

        for (const r of needExtension) {
          const acc = r.account_id ? accMap.get(r.account_id) : null
          const name = acc?.company_name || "(Individual)"
          const ein = acc?.ein_number || "N/A"
          const entity = acc?.entity_type || "N/A"
          const state = acc?.state_of_formation || "N/A"
          csvLines.push(`${name},${ein},${entity},${state},${r.return_type || "N/A"},${r.id}`)
          tableLines.push(`| ${name} | ${ein} | ${entity} | ${state} | ${r.return_type || "N/A"} |`)
        }

        const lines = [
          `═══════════════════════════════════════`,
          `  Tax Extension List — ${tax_year}`,
          `═══════════════════════════════════════`,
          "",
          `Total tax returns: ${returns.length}`,
          `Need extension: ${needExtension.length}`,
          `Already filed: ${alreadyFiled.length}`,
          "",
        ]

        if (needExtension.length > 0) {
          lines.push("| Company | EIN | Entity | State | Return Type |")
          lines.push("|---------|-----|--------|-------|-------------|")
          lines.push(...tableLines)
        }

        // Send email if requested
        if (send_to_email && needExtension.length > 0) {
          try {
            const { gmailPost } = await import("@/lib/gmail")
            const csvContent = csvLines.join("\n")
            const boundary = "boundary_" + Date.now()
            const emailBody = [
              `Tax Extension List for ${tax_year}`,
              "",
              `Total clients needing extension: ${needExtension.length}`,
              `Already filed: ${alreadyFiled.length}`,
              "",
              "Please file Form 7004 for all clients in the attached CSV.",
              "Return the filing IDs (Submission ID) for each client once completed.",
              "",
              "Tony Durante LLC",
            ].join("\n")

            const parts = [
              `--${boundary}`,
              `Content-Type: text/plain; charset=utf-8`,
              `Content-Transfer-Encoding: base64`,
              "",
              Buffer.from(emailBody).toString("base64"),
              `--${boundary}`,
              `Content-Type: text/csv; name="Tax_Extensions_${tax_year}.csv"`,
              `Content-Transfer-Encoding: base64`,
              `Content-Disposition: attachment; filename="Tax_Extensions_${tax_year}.csv"`,
              "",
              Buffer.from(csvContent).toString("base64"),
              `--${boundary}--`,
            ]

            const mimeMessage = [
              `From: Tony Durante LLC <support@tonydurante.us>`,
              `To: ${send_to_email}`,
              `Subject: Tax Extension List ${tax_year} — ${needExtension.length} clients`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/mixed; boundary="${boundary}"`,
              "",
              ...parts,
            ].join("\r\n")

            await gmailPost("/messages/send", { raw: Buffer.from(mimeMessage).toString("base64url") })
            lines.push("")
            lines.push(`📧 Extension list sent to ${send_to_email}`)
          } catch (e) {
            lines.push(`⚠️ Email failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_extension_update
  // ═══════════════════════════════════════
  server.tool(
    "tax_extension_update",
    "Bulk update extension filing status for tax returns. Use after receiving filing IDs from the India team. Accepts an array of {tax_return_id, submission_id} pairs and marks each as extension_filed=true with the confirmation ID.",
    {
      tax_year: z.number().describe("Tax year"),
      extensions: z.array(z.object({
        tax_return_id: z.string().uuid().describe("Tax return UUID"),
        submission_id: z.string().describe("Filing/Submission ID from India team"),
      })).describe("Array of {tax_return_id, submission_id} pairs"),
    },
    async ({ tax_year, extensions }) => {
      try {
        let updated = 0
        let failed = 0
        const errors: string[] = []

        for (const ext of extensions) {
          try {
            const { error } = await supabaseAdmin
              .from("tax_returns")
              .update({
                extension_filed: true,
                extension_confirmed_date: new Date().toISOString().slice(0, 10),
                extension_submission_id: ext.submission_id,
              })
              .eq("id", ext.tax_return_id)
              .eq("tax_year", tax_year)

            if (error) {
              errors.push(`${ext.tax_return_id}: ${error.message}`)
              failed++
            } else {
              updated++
            }
          } catch (e) {
            errors.push(`${ext.tax_return_id}: ${e instanceof Error ? e.message : String(e)}`)
            failed++
          }
        }

        const lines = [
          `✅ Extension update complete for ${tax_year}`,
          `   Updated: ${updated}`,
          `   Failed: ${failed}`,
        ]
        if (errors.length > 0) {
          lines.push("")
          lines.push("Errors:")
          errors.forEach(e => lines.push(`   • ${e}`))
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // tax_send_to_accountant
  // ═══════════════════════════════════════
  server.tool(
    "tax_send_to_accountant",
    `Send all tax return documents to the accountant for preparation. Gathers all required documents from Drive for a given account + tax_year: Tax Organizer PDF, P&L Excel (MMLLC/Corp), prior year return, and bank statements. Sends one email with all attachments. Updates tax_returns status. Idempotent: skips if already sent unless force_resend=true. Prerequisites: tax form must be completed, documents must be in Drive 3.Tax/{year}/ folder. Use tax_search first to find the tax return.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      accountant_email: z.string().email().optional().default("tax@adasglobus.com").describe("Accountant email (default: tax@adasglobus.com)"),
      force_resend: z.boolean().optional().default(false).describe("Override idempotency check to re-send"),
    },
    async ({ account_id, tax_year, accountant_email, force_resend }) => {
      try {
        const toEmail = accountant_email || "tax@adasglobus.com"

        // ── 1. Gather context ──
        const { data: account } = await supabaseAdmin
          .from("accounts")
          .select("company_name, ein_number, entity_type, drive_folder_id")
          .eq("id", account_id)
          .single()

        if (!account) return { content: [{ type: "text" as const, text: "❌ Account not found" }] }
        if (!account.drive_folder_id) return { content: [{ type: "text" as const, text: "❌ Account has no Drive folder" }] }

        // Get primary contact
        const { data: contactLink } = await supabaseAdmin
          .from("account_contacts")
          .select("contacts(full_name, first_name, last_name, email)")
          .eq("account_id", account_id)
          .limit(1)
          .single()

        const contact = (contactLink as unknown as { contacts: { full_name?: string; first_name: string; last_name: string; email: string } | null })?.contacts
        const contactName = contact?.full_name || `${contact?.first_name || ""} ${contact?.last_name || ""}`.trim() || "Unknown"

        // Get tax return record
        const { data: taxReturn } = await supabaseAdmin
          .from("tax_returns")
          .select("*")
          .eq("account_id", account_id)
          .eq("tax_year", tax_year)
          .maybeSingle()

        if (!taxReturn) return { content: [{ type: "text" as const, text: `❌ No tax return found for ${account.company_name} (${tax_year})` }] }

        // ── 2. Idempotency check ──
        if (taxReturn.sent_to_india && !force_resend) {
          return { content: [{ type: "text" as const, text: `⚠️ Already sent to accountant on ${taxReturn.sent_to_india_date}. Use force_resend=true to re-send.` }] }
        }

        // ── 3. Determine required docs by entity type ──
        const entityType = account.entity_type || "SMLLC"
        const returnTypeMap: Record<string, string> = { "Single Member LLC": "5472", "Multi-Member LLC": "1065", "Multi Member LLC": "1065", "Corporation": "1120", "SMLLC": "5472", "MMLLC": "1065", "Corp": "1120" }
        const returnType = returnTypeMap[entityType] || taxReturn.return_type || entityType
        const needsPnl = /multi.?member|mmllc|corp/i.test(entityType)

        // ── 4. Find files on Drive ──
        const taxFolderId = await findTaxFolder(account.drive_folder_id)
        if (!taxFolderId) return { content: [{ type: "text" as const, text: "❌ No '3. Tax' folder found in Drive" }] }

        // Find year subfolder
        const yearListing = (await listFolder(taxFolderId, 100)) as { files?: { id: string; name: string; mimeType: string }[] }
        const yearFolder = yearListing.files?.find(f => f.name === String(tax_year) && f.mimeType === "application/vnd.google-apps.folder")
        const priorYearFolder = yearListing.files?.find(f => f.name === String(tax_year - 1) && f.mimeType === "application/vnd.google-apps.folder")

        interface DriveFile { id: string; name: string; mimeType: string; category: string }
        const foundFiles: DriveFile[] = []
        const missing: string[] = []

        // Search both year subfolder AND Tax root (files may be in either location)
        const searchFolders: { id: string; files?: { id: string; name: string; mimeType: string }[] }[] = []

        // Year subfolder (if exists)
        if (yearFolder) {
          const yearFiles = (await listFolder(yearFolder.id, 100)) as { files?: { id: string; name: string; mimeType: string }[] }
          searchFolders.push({ id: yearFolder.id, files: yearFiles.files })
        }
        // Tax root folder (always search — files may not be in a year subfolder)
        const rootFiles = (yearListing.files || []).filter(f => f.mimeType !== "application/vnd.google-apps.folder")
        searchFolders.push({ id: taxFolderId, files: rootFiles })

        // Flatten all files from both locations (deduplicate by ID)
        const allSearchFiles: { id: string; name: string; mimeType: string }[] = []
        for (const folder of searchFolders) {
          for (const f of (folder.files || [])) {
            if (!allSearchFiles.some(existing => existing.id === f.id)) allSearchFiles.push(f)
          }
        }

        // Tax Organizer PDF
        const taxOrganizerPdf = allSearchFiles.find(f => /tax.?data|tax.?organizer|complete.?data/i.test(f.name) && /pdf/i.test(f.mimeType || f.name))
        if (taxOrganizerPdf) {
          foundFiles.push({ ...taxOrganizerPdf, category: "Tax Organizer" })
        } else {
          missing.push("Tax Organizer PDF")
        }

        // P&L Excel
        if (needsPnl) {
          const pnlExcel = allSearchFiles.find(f => /p&l|pnl|profit.?loss/i.test(f.name) && /spreadsheet|xlsx/i.test(f.mimeType || f.name))
          if (pnlExcel) {
            foundFiles.push({ ...pnlExcel, category: "P&L + Balance Sheet" })
          } else {
            missing.push("P&L Excel")
          }
        }

        // Bank statements
        if (needsPnl) {
          const stmtPattern = /wise|mercury|relay|statement|bank|estratto/i
          const stmts = allSearchFiles.filter(f => stmtPattern.test(f.name) && /pdf|csv/i.test(f.mimeType || f.name))
          for (const s of stmts) {
            if (!foundFiles.some(ff => ff.id === s.id)) foundFiles.push({ ...s, category: "Bank Statement" })
          }
        }

        // Prior year return
        if (priorYearFolder) {
          const priorFiles = (await listFolder(priorYearFolder.id, 50)) as { files?: { id: string; name: string; mimeType: string }[] }
          const priorReturn = priorFiles.files?.find(f => /return|1065|1120|5472|filed/i.test(f.name) && /pdf/i.test(f.mimeType || f.name))
          if (priorReturn) {
            foundFiles.push({ ...priorReturn, category: "Prior Year Return" })
          }
          // Not a hard requirement — prior year might not exist for first-year LLCs
        }

        // ── 5. Validate ──
        if (missing.length > 0 && !force_resend) {
          const lines = [
            `⚠️ Missing documents for ${account.company_name} (${tax_year}):`,
            ...missing.map(m => `   ❌ ${m}`),
            "",
            `Found ${foundFiles.length} documents:`,
            ...foundFiles.map(f => `   ✅ ${f.category}: ${f.name}`),
            "",
            "Upload missing documents to Drive first, or use force_resend=true to send anyway.",
          ]
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        if (foundFiles.length === 0) {
          return { content: [{ type: "text" as const, text: `❌ No documents found in Drive for ${account.company_name} (${tax_year}). Upload documents first.` }] }
        }

        // ── 6. Download all files and build MIME email ──
        const attachments: { filename: string; content: string; content_type: string }[] = []
        for (const file of foundFiles) {
          try {
            const { buffer, mimeType, fileName } = await downloadFileBinary(file.id)
            attachments.push({
              filename: fileName || file.name,
              content: buffer.toString("base64"),
              content_type: mimeType || "application/octet-stream",
            })
          } catch (dlErr) {
            // Skip files that fail to download
          }
        }

        if (attachments.length === 0) {
          return { content: [{ type: "text" as const, text: "❌ Failed to download any files from Drive" }] }
        }

        const emailSubject = `${account.company_name} - ${contactName} - ${account.ein_number || "NO EIN"} - ${returnType}`
        const docList = foundFiles.map(f => `<li>${f.category}: ${f.name}</li>`).join("")
        const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<p>Please find attached the tax return documents for preparation.</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:4px 12px;font-weight:bold">Company:</td><td style="padding:4px 12px">${account.company_name}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold">Owner/Contact:</td><td style="padding:4px 12px">${contactName}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold">EIN:</td><td style="padding:4px 12px">${account.ein_number || "N/A"}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold">Entity Type:</td><td style="padding:4px 12px">${entityType}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold">Return Type:</td><td style="padding:4px 12px">Form ${returnType}</td></tr>
<tr><td style="padding:4px 12px;font-weight:bold">Tax Year:</td><td style="padding:4px 12px">${tax_year}</td></tr>
</table>
<p><strong>Documents attached (${attachments.length}):</strong></p>
<ul>${docList}</ul>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
<p style="font-size:12px;color:#6b7280">Sent by Tony Durante LLC CRM</p>
</div>`

        const plainText = `Tax return documents for ${account.company_name} (${tax_year})\nEIN: ${account.ein_number}\nEntity: ${entityType}\nReturn: Form ${returnType}\n\nDocuments: ${foundFiles.map(f => f.name).join(", ")}`

        // Build MIME with attachments
        const outerBoundary = `boundary_${Date.now()}`
        const altBoundary = `alt_boundary_${Date.now()}`

        const mimeHeaders = [
          "From: Tony Durante LLC <support@tonydurante.us>",
          `To: ${toEmail}`,
          `Subject: ${emailSubject}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
        ]

        const mimeParts: string[] = [mimeHeaders.join("\r\n"), ""]

        // Body part (multipart/alternative)
        mimeParts.push(`--${outerBoundary}`)
        mimeParts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
        mimeParts.push("")
        mimeParts.push(`--${altBoundary}`)
        mimeParts.push("Content-Type: text/plain; charset=utf-8")
        mimeParts.push("Content-Transfer-Encoding: base64")
        mimeParts.push("")
        mimeParts.push(Buffer.from(plainText).toString("base64"))
        mimeParts.push("")
        mimeParts.push(`--${altBoundary}`)
        mimeParts.push("Content-Type: text/html; charset=utf-8")
        mimeParts.push("Content-Transfer-Encoding: base64")
        mimeParts.push("")
        mimeParts.push(Buffer.from(htmlBody).toString("base64"))
        mimeParts.push("")
        mimeParts.push(`--${altBoundary}--`)

        // Attachment parts
        for (const att of attachments) {
          mimeParts.push("")
          mimeParts.push(`--${outerBoundary}`)
          mimeParts.push(`Content-Type: ${att.content_type}; name="${att.filename}"`)
          mimeParts.push("Content-Transfer-Encoding: base64")
          mimeParts.push(`Content-Disposition: attachment; filename="${att.filename}"`)
          mimeParts.push("")
          mimeParts.push(att.content)
        }
        mimeParts.push("")
        mimeParts.push(`--${outerBoundary}--`)

        const raw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

        // ── 7. Send email ──
        await gmailPost("/messages/send", { raw })

        // ── 8. Update CRM ──
        const today = new Date().toISOString().slice(0, 10)
        await supabaseAdmin
          .from("tax_returns")
          .update({
            sent_to_india: true,
            sent_to_india_date: today,
            india_status: "Sent - Pending",
            status: "Sent to India",
            updated_at: new Date().toISOString(),
          })
          .eq("id", taxReturn.id)

        // Advance SD if appropriate
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, current_stage")
          .eq("account_id", account_id)
          .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
          .eq("status", "active")
          .maybeSingle()

        if (sd) {
          await supabaseAdmin
            .from("service_deliveries")
            .update({
              current_stage: "Preparation - Sent to Accountant",
              updated_at: new Date().toISOString(),
            })
            .eq("id", sd.id)
        }

        // Log action
        logAction({
          action_type: "tax_send_to_accountant",
          table_name: "tax_returns",
          record_id: taxReturn.id,
          account_id,
          summary: `Tax documents sent to accountant for ${account.company_name} (${tax_year})`,
          details: { files: foundFiles.map(f => f.name), entity_type: entityType, email: toEmail },
        })

        // ── 9. Return summary ──
        const lines = [
          `✅ Tax documents sent to accountant`,
          "",
          `📧 To: ${toEmail}`,
          `📋 Subject: ${emailSubject}`,
          "",
          `📎 Documents attached (${attachments.length}):`,
          ...foundFiles.map(f => `   • ${f.category}: ${f.name}`),
          "",
          `📝 CRM Updates:`,
          `   • tax_returns: status → "Sent to India", india_status → "Sent - Pending"`,
          sd ? `   • Service delivery: stage → "Preparation - Sent to Accountant"` : `   • No active service delivery found`,
          "",
          missing.length > 0 ? `⚠️ Missing (sent anyway): ${missing.join(", ")}` : "",
        ].filter(Boolean)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

} // end registerTaxTools

function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  const now = new Date()
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}
