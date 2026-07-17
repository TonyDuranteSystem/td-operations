/**
 * Tax Return Tools — Search and track tax returns with visual dashboard.
 * Color-coded status tracking for tax season management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { listFolder, findTaxFolder, findOrCreateYearFolder as _findOrCreateYearFolder, downloadFileBinary } from "@/lib/google-drive"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"
import type { Json } from "@/lib/database.types"

export function registerTaxTools(server: McpServer) {

  // ═══════════════════════════════════════
  // tax_search
  // ═══════════════════════════════════════
  server.tool(
    "tax_search",
    "Search tax returns by year, status, return type, account, or special case flag. Returns company name, return type (1065/1120-S/1040NR), status, deadline, and workflow progress (paid/link_sent/data_received/sent_to_accountant/extension/accountant_status). Use tax_tracker for the visual dashboard overview.",
    {
      tax_year: z.number().optional().describe("Tax year (e.g., 2025)"),
      status: z.string().optional().describe("Status: Payment Pending, Paid - Not Started, Activated - Need Link, Link Sent - Awaiting Data, Wizard Available, Data Received, Sent to Accountant, Extension Filed, TR Completed - Awaiting Signature, TR Filed, Not Invoiced"),
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (status) q = q.eq("status", status as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (return_type) q = q.eq("return_type", return_type as any)
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
          "Wizard Available": "🟡",
          "Data Received": "🟡",
          "Sent to Accountant": "🔵",
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
          const accountant = tr.accountant_status && tr.accountant_status !== "Not Sent" ? ` | Accountant: ${tr.accountant_status}` : ""

          lines.push(`${icon} ${tr.company_name}${special}`)
          lines.push(`   ${tr.return_type} ${tr.tax_year} | ${tr.status}${accountant}`)
          lines.push(`   Deadline: ${deadline}${ext}`)

          // Workflow progress
          const steps = [
            tr.paid ? "✅ Paid" : "⬜ Paid",
            tr.link_sent ? "✅ Link" : "⬜ Link",
            tr.data_received ? "✅ Data" : "⬜ Data",
            tr.sent_to_accountant ? "✅ Accountant" : "⬜ Accountant",
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
          .select("*, accounts!left(is_test)")
          .eq("tax_year", year)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (return_type) q = q.eq("return_type", return_type as any)

        const { data: rawData, error } = await q
        if (error) throw new Error(error.message)
        // Exclude tax returns linked to test accounts
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (rawData || []).filter((tr: any) => !tr.accounts?.is_test)
        if (data.length === 0) {
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
        const isWaiting = (s: string) => ["Link Sent - Awaiting Data", "Wizard Available"].includes(s)
        const isInProgress = (s: string) => ["Data Received", "Sent to Accountant", "Sent to India"].includes(s)
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
            // Accountant status sub-breakdown
            const accountantStatuses: Record<string, number> = {}
            for (const r of inProgress.filter(r => r.accountant_status)) {
              accountantStatuses[r.accountant_status] = (accountantStatuses[r.accountant_status] || 0) + 1
            }
            if (Object.keys(accountantStatuses).length > 0) {
              lines.push(`     Accountant: ${Object.entries(accountantStatuses).map(([s, c]) => `${s}: ${c}`).join(", ")}`)
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
    "Update a tax return's workflow fields — status, dates, accountant_status, extension, notes. Use tax_search first to find the ID. Common updates: mark as paid, set link_sent_date, update accountant_status, mark as filed.",
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
    // eslint-disable-next-line no-template-curly-in-string
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
            prefilled_data: prefilled as unknown as Json,
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
          lines.push("APPLYING CHANGES...")
          lines.push("")

          // ── Apply via shared helper (Slice 8) ──────────────────────────
          // Helper handles: enqueue tax_form_setup job + reviewed_at flip with
          // a reviewed_at IS NOT NULL short-circuit. Same code path used by
          // workflow handler tax.approve_and_apply — protects B9 across
          // MCP + workflow surfaces.
          const { approveAndApplyTaxReview } = await import("@/lib/operations/tax-review")
          const apply = await approveAndApplyTaxReview({
            submission_id: sub.id,
            actor: "claude",
          })

          if (!apply.ok) {
            lines.push(`❌ Apply failed: ${apply.error}`)
            return { content: [{ type: "text" as const, text: lines.join("\n") }] }
          }

          if (apply.alreadyApplied) {
            lines.push(`ℹ️ Submission already reviewed (reviewed_at was set). Skipping job enqueue + Drive save to avoid duplicates.`)
            return { content: [{ type: "text" as const, text: lines.join("\n") }] }
          }

          lines.push(`✅ Background job enqueued: ${apply.job_id}`)
          lines.push(`   Steps: Contact update → Account update → Tax return → Data Received → Form → reviewed`)
          lines.push("")
          lines.push(`➡️ Check progress: job_status('${apply.job_id}')`)

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
                const taxUploadPaths = (sub.upload_paths as string[]) || []
                // The submission's files live in whichever bucket they were
                // uploaded to: the PORTAL wizard uses "onboarding-uploads" with a
                // "tax/{id}/..." path scheme; the EXTERNAL public tax form uses
                // the "tax-form-uploads" config default with a "{slug}-{year}/..."
                // scheme. Pick by path prefix so staff review copies from the
                // right bucket for either source.
                const portalUpload = taxUploadPaths.some(p => p.startsWith("tax/"))
                const driveResult = await saveFormToDrive(
                  "tax_return",
                  submitted,
                  taxUploadPaths,
                  acc.drive_folder_id,
                  { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName, year: sub.tax_year },
                  portalUpload ? { bucket: "onboarding-uploads" } : undefined,
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
    "Generate the list of ALL clients needing a tax extension for a given tax year. Returns CSV-ready data: company name, EIN, entity type, state, return type. Use this in February to prepare the bulk extension list for the accountant. Optionally sends the list via email to a specified address.",
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
          .or("is_test.is.null,is_test.eq.false")

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
    "Bulk update extension filing status for tax returns. Use after receiving filing IDs from the accountant. Accepts an array of {tax_return_id, submission_id} pairs and marks each as extension_filed=true with the confirmation ID.",
    {
      tax_year: z.number().describe("Tax year"),
      extensions: z.array(z.object({
        tax_return_id: z.string().uuid().describe("Tax return UUID"),
        submission_id: z.string().describe("Filing/Submission ID from the accountant"),
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
    `Send all tax return documents to the accountant for preparation. Gathers all required documents from Drive for a given account + tax_year: Tax Organizer PDF, P&L Excel (MMLLC/Corp), prior year return, and bank statements. Use dry_run=true FIRST to review the document package before sending. With dry_run=false, sends one email with all attachments and updates tax_returns status. Idempotent: skips if already sent unless force_resend=true (that flag overrides ONLY the idempotency check — it never bypasses the document checks). Every attached document must provably belong to its tax year (by name, or by sitting in the year folder) — the tool refuses to attach another year's file, refuses to guess when several match (pass pnl_file_id / organizer_file_id to choose), and refuses outright if the P&L is missing on an entity that files one (pass no_pnl_reason only if the company genuinely has no books). Prerequisites: tax form must be completed, documents must be in Drive 3.Tax/{year}/ folder. Use tax_search first to find the tax return. ALWAYS run with dry_run=true first, get Antonio's approval, then run again with dry_run=false.`,
    {
      account_id: z.string().uuid().describe("CRM account UUID"),
      tax_year: z.number().describe("Tax year (e.g., 2025)"),
      dry_run: z.boolean().optional().default(true).describe("REQUIRED: true (default) = preview documents without sending. false = actually send email and update CRM. ALWAYS preview first."),
      accountant_email: z.string().email().optional().default("tax@adasglobus.com").describe("Accountant email (default: tax@adasglobus.com)"),
      force_resend: z.boolean().optional().default(false).describe("Override the idempotency check ONLY (re-send a year already sent). Does NOT bypass document checks."),
      send_incomplete: z.boolean().optional().default(false).describe("Send even though optional documents are missing. Never bypasses a missing P&L on an entity that requires one — use no_pnl_reason for that."),
      pnl_file_id: z.string().optional().describe("Drive file id of the P&L to attach. Needed to send when several files provably belong to the year — the tool refuses to guess which numbers get filed. Naming a file whose year cannot be proven is allowed but is recorded as your explicit choice."),
      organizer_file_id: z.string().optional().describe("Drive file id of the Tax Organizer to attach, when several provably belong to the year."),
      no_pnl_reason: z.string().optional().describe("Why this P&L-filing entity has no P&L (e.g. 'dormant — no transactions in 2025'). Required to send without one; recorded in the audit log."),
    },
    async ({ account_id, tax_year, dry_run, accountant_email, force_resend, send_incomplete, pnl_file_id, organizer_file_id, no_pnl_reason }) => {
      try {
        const isDryRun = dry_run !== false // default true
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
        if (taxReturn.sent_to_accountant && !force_resend) {
          return { content: [{ type: "text" as const, text: `⚠️ Already sent to accountant on ${taxReturn.sent_to_accountant_date}. Use force_resend=true to re-send.` }] }
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
        const yearListing = (await listFolder(taxFolderId, 100)) as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string }[]; nextPageToken?: string }
        const yearFolder = yearListing.files?.find(f => f.name === String(tax_year) && f.mimeType === "application/vnd.google-apps.folder")
        const priorYearFolder = yearListing.files?.find(f => f.name === String(tax_year - 1) && f.mimeType === "application/vnd.google-apps.folder")

        interface DriveFile { id: string; name: string; mimeType: string; category: string }
        const foundFiles: DriveFile[] = []
        const missing: string[] = []
        // Files that matched but could not be disambiguated — surfaced, never picked silently.
        const ambiguous: string[] = []

        // Search both year subfolder AND Tax root (files may be in either location)
        const searchFolders: { id: string; files?: { id: string; name: string; mimeType: string; modifiedTime?: string }[] }[] = []

        // Year subfolder (if exists). Track its file ids so a year-foldered file
        // outranks a loose one in the Tax root when both match.
        const yearFolderFileIds = new Set<string>()
        // name → when the year-folder copy of that name was last changed.
        const yearFolderModifiedByName = new Map<string, string>()
        let yearListingTruncated = false
        if (yearFolder) {
          const yearFiles = (await listFolder(yearFolder.id, 100)) as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string }[]; nextPageToken?: string }
          searchFolders.push({ id: yearFolder.id, files: yearFiles.files })
          for (const f of (yearFiles.files || [])) {
            yearFolderFileIds.add(f.id)
            // Folders are not documents — a root FILE must not be mistaken for a
            // legacy copy of a year-folder SUBFOLDER that happens to share a name.
            if (f.mimeType !== "application/vnd.google-apps.folder") {
              yearFolderModifiedByName.set(f.name, f.modifiedTime ?? "")
            }
          }
          yearListingTruncated = Boolean(yearFiles.nextPageToken)
        }
        // Tax root folder (always search — files may not be in a year subfolder).
        //
        // A root file whose name ALSO exists in the year subfolder — and which the
        // year-folder copy is demonstrably NEWER than — is a superseded leftover,
        // and is ignored rather than treated as a rival candidate. The confirmed
        // workbook used to be archived flat into the Tax root and is now archived
        // into the year folder; the upsert only replaces same-named files within
        // ONE folder, so every client who attested before this shipped keeps an
        // orphaned root twin with a BYTE-IDENTICAL NAME. Treating both as
        // candidates made them indistinguishable in the "which of these is it?"
        // prompt — two identical lines — and choosing the stale one filed
        // superseded numbers with no warning.
        //
        // The dates are COMPARED, never assumed: other paths still write to the
        // Tax root (a submission with no pinned year), so a root twin can be the
        // NEWER one. When it is, both stay in — which surfaces as an ambiguity and
        // stops the send, rather than silently dropping the corrected file.
        const { pickFileForYear, belongsToYear, matchesCategory, decideSendGate, isSupersededRootCopy } = await import("@/lib/tax/pick-tax-file")
        const isSuperseded = (f: { id: string; name: string; mimeType: string; modifiedTime?: string }) =>
          isSupersededRootCopy(f, yearFolderModifiedByName)
        const nonFolderRootFiles = (yearListing.files || []).filter(f => f.mimeType !== "application/vnd.google-apps.folder")
        const rootFiles = nonFolderRootFiles.filter(f => !isSuperseded(f))
        const supersededRootCopies = nonFolderRootFiles
          .filter(isSuperseded)
          .map(f => `"${f.name}" (Tax root copy last changed ${f.modifiedTime?.slice(0, 10) || "unknown"}; the ${tax_year} folder's copy is newer)`)
        searchFolders.push({ id: taxFolderId, files: rootFiles })

        // Flatten all files from both locations (deduplicate by ID)
        const allSearchFiles: { id: string; name: string; mimeType: string; modifiedTime?: string }[] = []
        for (const folder of searchFolders) {
          for (const f of (folder.files || [])) {
            if (!allSearchFiles.some(existing => existing.id === f.id)) allSearchFiles.push(f)
          }
        }

        // `listFolder` does not paginate, so a fuller folder comes back partial.
        // Everything below reasons about "every file that could be this year's" —
        // including the check that refuses to send when TWO files match. On a
        // partial listing that check would pass by accident, which is worse than
        // no check at all. Drive tells us it truncated by returning a page token;
        // trust that rather than counting rows (a folder of exactly 100 files is
        // complete, and a short page can still have more behind it).
        const truncated = [
          yearListing.nextPageToken ? "the '3. Tax' folder" : null,
          yearListingTruncated ? `the ${tax_year} subfolder` : null,
        ].filter(Boolean)
        if (truncated.length > 0) {
          return { content: [{ type: "text" as const, text: [
            `❌ Cannot send ${account.company_name} (${tax_year}): ${truncated.join(" and ")} holds more files than this tool can list in one go.`,
            "",
            `It must see every file to be sure it is attaching the right year's — on a partial listing it could miss a second P&L and send the wrong one without noticing.`,
            `Tidy the folder (move old files into their year subfolders) and try again.`,
          ].join("\n") }] }
        }

        // Every document must PROVABLY belong to this tax year before it can be
        // attached. Council 2026-07-17 (blocker): these were picked by name pattern
        // alone — first regex match, Drive-order dependent — across the year
        // subfolder AND the Tax root, with no year check. For a client with two
        // years of books that meant last year's organizer or P&L could be emailed
        // and filed as this year's return. See lib/tax/pick-tax-file.ts for the rule.
        const yearOpts = { yearFolderFileIds, companyName: account.company_name as string | undefined }
        const isPdf = (f: { name: string; mimeType?: string }) => /pdf/i.test(f.mimeType || "") || /\.pdf$/i.test(f.name)

        // Notes that are informational only — printed, never a reason to stop.
        const notes: string[] = []
        // A P&L-shaped file whose year we could not read, sitting beside the one
        // we picked. Blocks the send (see decideSendGate) — it may be the correction.
        const pnlConflicts: string[] = []
        if (supersededRootCopies.length > 0) {
          notes.push(`Ignored ${supersededRootCopies.length} superseded copy/copies left loose in the Tax root: ${supersededRootCopies.join(", ")}`)
        }
        // Files an operator deliberately named whose year we could not prove.
        const overrides: string[] = []

        /**
         * Resolve an explicitly named file id. Naming a file is a real human
         * decision, so a file whose YEAR can't be proven is accepted — and
         * recorded. But a file that isn't a document of that kind at all (the
         * organizer's id pasted into pnl_file_id — both ids are printed in the
         * same message) is a mistake, not a decision: refuse it.
         */
        const resolveChosen = (fileId: string, category: string, shape: { namePattern: RegExp; typeMatches: (f: { id: string; name: string; mimeType?: string }) => boolean }) => {
          // Searched against the UNFILTERED listing: if an operator deliberately
          // names a file we shadowed as a superseded root copy, they know
          // something we don't — "that file doesn't exist" would be a lie.
          const inCandidates = allSearchFiles.find(f => f.id === fileId)
          const chosen = inCandidates ?? nonFolderRootFiles.find(f => f.id === fileId)
          if (!chosen) return { file: null, error: `is not a file in this client's Tax folder or ${tax_year} subfolder` }
          if (!matchesCategory(chosen, { ...shape, companyName: yearOpts.companyName })) {
            return { file: null, error: `is "${chosen.name}" — that is not a ${category}. Check you copied the right id.` }
          }
          if (!belongsToYear(chosen, tax_year, yearOpts)) {
            overrides.push(`${category}: "${chosen.name}" (id ${chosen.id}) — you named this file yourself; nothing in its name proves it is the ${tax_year} one.`)
          }
          if (!inCandidates) {
            // Only reachable via the fallback above: this is a file we set aside as
            // a superseded Tax-root copy. Overriding that is a real decision and
            // must not be silent just because the file's YEAR happens to be provable.
            overrides.push(`${category}: "${chosen.name}" (id ${chosen.id}) — you named the older Tax-root copy, which the ${tax_year} folder has a newer version of.`)
          }
          return { file: chosen, error: null }
        }

        // Tax Organizer PDF
        const ORGANIZER_SHAPE = { namePattern: /tax.?data|tax.?organizer|complete.?data/i, typeMatches: isPdf }
        const organizerPick = pickFileForYear(allSearchFiles, tax_year, { ...yearOpts, ...ORGANIZER_SHAPE })
        if (organizerPick.conflictNote) notes.push(`Tax Organizer — ${organizerPick.conflictNote}`)
        let organizerFile = organizerPick.file
        if (organizer_file_id) {
          const r = resolveChosen(organizer_file_id, "Tax Organizer", ORGANIZER_SHAPE)
          if (!r.file) return { content: [{ type: "text" as const, text: `❌ organizer_file_id ${organizer_file_id} ${r.error}` }] }
          organizerFile = r.file
        }
        if (organizerFile) {
          foundFiles.push({ ...organizerFile, mimeType: organizerFile.mimeType ?? "", category: "Tax Organizer" })
          // Naming the file IS the resolution — the question is answered.
          if (organizerPick.ambiguityNote && !organizer_file_id) {
            ambiguous.push(`Tax Organizer — ${organizerPick.ambiguityNote} Pass organizer_file_id to choose.`)
          }
        } else {
          missing.push(
            organizerPick.conflictNote
              ? `Tax Organizer PDF for ${tax_year} — ${organizerPick.conflictNote}`
              : `Tax Organizer PDF for ${tax_year} (none found that provably belongs to ${tax_year})`,
          )
        }

        // P&L Excel — the numbers that get filed. A wrong-year pick here files
        // wrong numbers with the IRS, so a missing P&L is a HARD stop that no
        // flag bypasses (see the validate step below).
        let pnlMissing = false
        // Only true when we actually sent WITHOUT a P&L on this reason — the
        // audit log must not record "the company was dormant" on a send that
        // carried a P&L (an operator can pass both params).
        let noPnlDeclared = false
        // Never silently ignore an explicit instruction: these entities file no
        // P&L, so the params cannot do what the operator is asking for.
        if (!needsPnl && (pnl_file_id || no_pnl_reason)) {
          return { content: [{ type: "text" as const, text: `❌ ${account.company_name} is a ${entityType}, and this tool does not attach a P&L to a ${returnType} package — so ${pnl_file_id ? "pnl_file_id" : "no_pnl_reason"} would have no effect. Re-run without it, or correct the entity type if this company should be filing a P&L.` }] }
        }
        if (needsPnl) {
          const PNL_SHAPE = {
            namePattern: /p&l|pnl|profit.?loss/i,
            typeMatches: (f: { name: string; mimeType?: string }) => /spreadsheet|excel/i.test(f.mimeType || "") || /\.xlsx?$/i.test(f.name),
          }
          const pick = pickFileForYear(allSearchFiles, tax_year, { ...yearOpts, ...PNL_SHAPE })
          let chosen = pick.file
          if (pnl_file_id) {
            const r = resolveChosen(pnl_file_id, "P&L", PNL_SHAPE)
            if (!r.file) return { content: [{ type: "text" as const, text: `❌ pnl_file_id ${pnl_file_id} ${r.error}` }] }
            chosen = r.file
          }
          if (pick.conflictNote) {
            // If a P&L was picked while another P&L-shaped file couldn't be read,
            // that other file may well be the CORRECTED one — it is the MORE
            // suspicious of the two, since renaming a file with a revision date is
            // exactly how a correction gets made. Printing that as a footnote and
            // sending anyway is the theatre this whole change exists to stop, so
            // it blocks the send until a human names the file. Naming any file by
            // id settles the question.
            // Never report the file we just attached as "not used" — an operator
            // who named it by id has already answered this question, and a
            // self-contradicting warning is how real warnings stop being read.
            const unusedConflicts = pick.conflicted.filter(f => f.id !== chosen?.id)
            if (chosen && !pnl_file_id) {
              pnlConflicts.push(`P&L — attaching "${chosen.name}", but ${pick.conflictNote} If one of those is the corrected P&L, pass pnl_file_id to use it instead; if none of them is, pass pnl_file_id=${chosen.id} to confirm this one.`)
            } else if (unusedConflicts.length > 0) {
              notes.push(`P&L — ${unusedConflicts.length} other file(s) mention ${tax_year} next to another year, so their year cannot be read from the name and they were NOT used: ${unusedConflicts.map(f => `"${f.name}" (id ${f.id})`).join(", ")}`)
            }
          }
          if (chosen) {
            foundFiles.push({ ...chosen, mimeType: chosen.mimeType ?? "", category: "P&L + Balance Sheet" })
            if (pick.ambiguityNote && !pnl_file_id) ambiguous.push(`P&L — ${pick.ambiguityNote} Pass pnl_file_id to choose.`)
          } else if (no_pnl_reason && pick.candidates.length === 0 && !pick.conflictNote) {
            // "Dormant" means there are no books at all. If P&L-shaped files DO
            // exist and we merely couldn't read their year, the honest answer is
            // "name the file", not "declare the company dormant". A genuinely
            // dormant or first-year company still files an informational return,
            // so that case is allowed — with the reason recorded.
            noPnlDeclared = true
            overrides.push(`P&L: none attached — ${no_pnl_reason}`)
          } else {
            pnlMissing = true
            missing.push(
              pick.conflictNote
                ? `P&L Excel for ${tax_year} — ${pick.conflictNote}`
                : `P&L Excel for ${tax_year} (none found that provably belongs to ${tax_year} — refusing to attach another year's P&L)`,
            )
          }
        }

        // Bank statements — supporting docs, but a wrong-year statement is still
        // wrong. Only attach the ones that provably belong to this year; say out
        // loud which ones were left out rather than dropping them silently.
        const excludedStatements: string[] = []
        if (needsPnl) {
          // Matched on the residue: a client called "Relay Ltd" or "Mercury LLC"
          // must not have every PDF it owns read as a bank statement.
          const stmts = allSearchFiles.filter(f => matchesCategory(f, {
            ...yearOpts,
            namePattern: /wise|mercury|relay|statement|bank|estratto/i,
            typeMatches: c => /pdf|csv/i.test(c.mimeType || "") || /\.(pdf|csv)$/i.test(c.name),
          }))
          for (const s of stmts) {
            if (foundFiles.some(ff => ff.id === s.id)) continue
            if (belongsToYear(s, tax_year, yearOpts)) foundFiles.push({ ...s, category: "Bank Statement" })
            else excludedStatements.push(s.name)
          }
        }

        // Prior year return. Its year is proven by the folder it sits in, but it
        // still goes through the same picker: a first-regex-match would happily
        // attach "2024 return DRAFT (not filed).pdf" over the filed one, because
        // Drive lists by name and "DRAFT" sorts first.
        if (priorYearFolder) {
          const priorFiles = (await listFolder(priorYearFolder.id, 50)) as { files?: { id: string; name: string; mimeType: string; modifiedTime?: string }[]; nextPageToken?: string }
          const priorIds = new Set((priorFiles.files || []).map(f => f.id))
          const priorPick = pickFileForYear(priorFiles.files || [], tax_year - 1, {
            companyName: yearOpts.companyName,
            yearFolderFileIds: priorIds, // everything here is proven by location
            namePattern: /return|1065|1120|5472|filed/i,
            typeMatches: isPdf,
          })
          if (priorPick.file) {
            foundFiles.push({ ...priorPick.file, mimeType: priorPick.file.mimeType ?? "", category: "Prior Year Return" })
            if (priorPick.ambiguityNote) notes.push(`Prior Year Return — ${priorPick.ambiguityNote}`)
          }
          if (priorPick.conflictNote) notes.push(`Prior Year Return — ${priorPick.conflictNote}`)
          if (priorFiles.nextPageToken) {
            notes.push(`Prior Year Return — the ${tax_year - 1} folder holds more files than can be listed at once, so ${priorPick.file ? "a better match may have been missed" : "no prior return was found"}.`)
          }
          // Not a hard requirement — prior year might not exist for first-year LLCs
        }

        // ── 5. Validate ──
        // Council 2026-07-17: force_resend is an IDEMPOTENCY override (re-send a
        // year already sent) and nothing more. It used to switch the document
        // checks off too — which meant the checks were disabled for precisely the
        // sends that need them most: the corrected re-sends. send_incomplete is
        // now the separate, explicit opt-out for optional documents, and a missing
        // P&L is a hard stop that neither flag bypasses. The decision itself is a
        // pure function (decideSendGate) so the rules that stop a wrong filing are
        // unit-tested; only the wording lives here.
        const gate = decideSendGate({ pnlMissing, ambiguous, pnlConflicts, missing, sendIncomplete: send_incomplete, isDryRun, foundCount: foundFiles.length })
        const blockedBy = gate.allow ? null : gate.reason
        if (blockedBy === "no_pnl") {
          const lines = [
            `❌ Cannot send ${account.company_name} (${tax_year}): no P&L that provably belongs to ${tax_year}.`,
            "",
            ...missing.map(m => `   ❌ ${m}`),
            ...(notes.length > 0 ? ["", `Files found but NOT used — check none of these was the one you meant:`, ...notes.map(n => `   • ${n}`)] : []),
            ...([...ambiguous, ...pnlConflicts].length > 0 ? ["", `Also unresolved:`, ...[...ambiguous, ...pnlConflicts].map(a => `   • ${a}`)] : []),
            "",
            `This entity (${entityType}) files a ${returnType}, which needs the P&L — sending without it, or with another year's, would file the wrong numbers.`,
            "",
            `Ways forward:`,
            `   • Upload the ${tax_year} workbook to Drive 3.Tax/${tax_year}/, or have the client re-confirm the financials in the portal.`,
            `   • pnl_file_id=<Drive id> — name the exact file (any ids found are listed above).`,
            `   • no_pnl_reason="..." — if the company genuinely has no books for ${tax_year} (dormant / first year), say so and it will be sent without a P&L and recorded.`,
          ]
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        // An unresolved ambiguity must stop the send, not ride along as a footnote
        // in the output after the email is already gone.
        if (blockedBy === "ambiguous") {
          const lines = [
            `❌ Cannot send ${account.company_name} (${tax_year}): more than one file could be the right one, and this tool will not guess which numbers get filed.`,
            "",
            ...ambiguous.map(a => `   • ${a}`),
            "",
            `Re-run with dry_run=true to review, name the file (pnl_file_id / organizer_file_id — the ids are in the notes above), or clean up the duplicates in Drive.`,
          ]
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        if (blockedBy === "pnl_conflict") {
          const lines = [
            `❌ Cannot send ${account.company_name} (${tax_year}): there is another P&L-shaped file whose year can't be read, and it may be the one that should be filed.`,
            "",
            ...pnlConflicts.map(c => `   • ${c}`),
            "",
            `A file named like "PnL 2024 (revised 2025-01-30)" mentions two years, so nothing in its name says which year it is for — but that is also exactly how a corrected P&L usually gets named. Name the file you mean with pnl_file_id.`,
          ]
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        if (blockedBy === "missing_docs") {
          const lines = [
            `⚠️ Missing documents for ${account.company_name} (${tax_year}):`,
            ...missing.map(m => `   ❌ ${m}`),
            "",
            `Found ${foundFiles.length} documents:`,
            ...foundFiles.map(f => `   ✅ ${f.category}: ${f.name}`),
            ...(ambiguous.length > 0 ? ["", `⚠️ Several files matched — confirm the right one:`, ...ambiguous.map(a => `   • ${a}`)] : []),
            "",
            "Upload the missing documents to Drive first, or use send_incomplete=true to send anyway.",
          ]
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        if (blockedBy === "no_documents") {
          return { content: [{ type: "text" as const, text: `❌ No documents found in Drive for ${account.company_name} (${tax_year}). Upload documents first.` }] }
        }

        // ── 5b. DRY RUN — preview without sending ──
        if (isDryRun) {
          const emailSubjectPreview = `${account.company_name} - ${contactName} - ${account.ein_number || "NO EIN"} - ${returnType}`
          const lines = [
            `📋 DRY RUN — Document package preview (NOT sent)`,
            "",
            `📧 Would send to: ${toEmail}`,
            `📋 Subject: ${emailSubjectPreview}`,
            `🏢 Company: ${account.company_name}`,
            `👤 Contact: ${contactName}`,
            `🆔 EIN: ${account.ein_number || "N/A"}`,
            `📊 Entity: ${entityType} → Form ${returnType}`,
            `📅 Tax Year: ${tax_year}`,
            "",
            `📎 Documents to attach (${foundFiles.length}):`,
            ...foundFiles.map(f => `   ✅ ${f.category}: ${f.name}`),
          ]
          if (missing.length > 0) {
            lines.push("", `⚠️ Missing (optional):`, ...missing.map(m => `   • ${m}`))
          }
          if (excludedStatements.length > 0) {
            lines.push("", `ℹ️ Statements left out (do not provably belong to ${tax_year}):`, ...excludedStatements.map(s => `   • ${s}`))
          }
          if (notes.length > 0) {
            lines.push("", `⚠️ Files found but NOT used — check none of these was the one you meant:`, ...notes.map(n => `   • ${n}`))
          }
          if (overrides.length > 0) {
            lines.push("", `⚠️ YOUR EXPLICIT CHOICES — check these before sending:`, ...overrides.map(o => `   • ${o}`))
          }
          const nativeGoogleDocs = foundFiles.filter(f => /vnd\.google-apps\./i.test(f.mimeType || ""))
          if (nativeGoogleDocs.length > 0) {
            lines.push("", `⚠️ These are Google-native files and CANNOT be attached — re-upload them as real .xlsx/.pdf first:`, ...nativeGoogleDocs.map(f => `   • ${f.category}: ${f.name}`))
          }
          const blocking = [...ambiguous, ...pnlConflicts]
          if (blocking.length > 0) {
            lines.push(
              "",
              `⚠️ More than one file could be the right one — the send is BLOCKED until this is resolved:`,
              ...blocking.map(a => `   • ${a}`),
              "",
              `Name the file you mean (pnl_file_id / organizer_file_id — the ids are in the lines above), or clean up the duplicates in Drive.`,
            )
          } else if (notes.length > 0 || overrides.length > 0 || nativeGoogleDocs.length > 0) {
            // Never print a bare "ready to send" over a warning — that is exactly
            // how someone clicks past the one line that mattered.
            lines.push("", `⚠️ Read the warnings above first. If they are right, run again with dry_run=false to send.`)
          } else {
            lines.push("", `✅ Ready to send. Run again with dry_run=false to send the email.`)
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") }] }
        }

        // ── 6. Download all files and build MIME email ──
        // Council 2026-07-17: a failed download used to be swallowed while the
        // email body and the summary were both built from the files we MEANT to
        // attach — so the accountant could receive a mail listing a P&L that
        // wasn't there, and the tool reported success. The email now describes
        // only what actually attached, and losing a required document is fatal.
        const attachments: { filename: string; content: string; content_type: string }[] = []
        const attachedFiles: DriveFile[] = []
        const failedDownloads: string[] = []
        for (const file of foundFiles) {
          try {
            const { buffer, mimeType, fileName } = await downloadFileBinary(file.id)
            attachments.push({
              filename: fileName || file.name,
              content: buffer.toString("base64"),
              content_type: mimeType || "application/octet-stream",
            })
            attachedFiles.push(file)
          } catch (dlErr) {
            failedDownloads.push(`${file.category}: ${file.name} — ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`)
          }
        }

        const lostRequired = failedDownloads.filter(f => /^(P&L \+ Balance Sheet|Tax Organizer):/.test(f))
        if (lostRequired.length > 0) {
          return { content: [{ type: "text" as const, text: [
            `❌ Nothing sent for ${account.company_name} (${tax_year}) — a required document could not be downloaded from Drive:`,
            "",
            ...lostRequired.map(f => `   • ${f}`),
            "",
            `(A Google-native Sheet/Doc cannot be downloaded as a file — re-upload it as a real .xlsx/.pdf.)`,
          ].join("\n") }] }
        }

        if (attachments.length === 0) {
          return { content: [{ type: "text" as const, text: "❌ Failed to download any files from Drive" }] }
        }

        const emailSubject = `${account.company_name} - ${contactName} - ${account.ein_number || "NO EIN"} - ${returnType}`
        // Describe what is actually attached, not what we hoped to attach.
        const docList = attachedFiles.map(f => `<li>${f.category}: ${f.name}</li>`).join("")
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

        const plainText = `Tax return documents for ${account.company_name} (${tax_year})\nEIN: ${account.ein_number}\nEntity: ${entityType}\nReturn: Form ${returnType}\n\nDocuments: ${attachedFiles.map(f => f.name).join(", ")}`

        // Build MIME with attachments
        const outerBoundary = `boundary_${Date.now()}`
        const altBoundary = `alt_boundary_${Date.now()}`

        const encodedSubject = `=?utf-8?B?${Buffer.from(emailSubject).toString("base64")}?=`
        const mimeHeaders = [
          "From: Tony Durante LLC <support@tonydurante.us>",
          `To: ${toEmail}`,
          `Subject: ${encodedSubject}`,
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
            sent_to_accountant: true,
            sent_to_accountant_date: today,
            accountant_status: "Sent - Pending",
            status: "Sent to Accountant",
            updated_at: new Date().toISOString(),
          })
          .eq("id", taxReturn.id)

        // Advance SD if appropriate
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage")
          .eq("account_id", account_id)
          .or("service_type.eq.Tax Return,service_type.eq.Tax Return Filing")
          .eq("status", "active")
          .maybeSingle()

        if (sd) {
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          await supabaseAdmin
            .from("service_deliveries")
            .update({
              stage: "Sent to be filed",
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
          details: {
            // Ids, not just names: two files can share a name byte-for-byte (a
            // legacy Tax-root copy and its replacement), and the audit trail of an
            // IRS filing has to be able to say WHICH file's numbers went.
            files: attachedFiles.map(f => `${f.name} [${f.id}]`),
            entity_type: entityType,
            email: toEmail,
            // No `ambiguous` here by design: an unresolved ambiguity never reaches
            // a send — it returns above. Logging it would only ever log nothing.
            ...(overrides.length > 0 ? { operator_overrides: overrides } : {}),
            ...(noPnlDeclared ? { no_pnl_reason } : {}),
            ...(notes.length > 0 ? { files_found_but_not_used: notes } : {}),
            ...(failedDownloads.length > 0 ? { failed_downloads: failedDownloads } : {}),
            ...(excludedStatements.length > 0 ? { excluded_statements: excludedStatements } : {}),
          },
        })

        // ── 9. Return summary ──
        const lines = [
          `✅ Tax documents sent to accountant`,
          "",
          `📧 To: ${toEmail}`,
          `📋 Subject: ${emailSubject}`,
          "",
          `📎 Documents attached (${attachments.length}):`,
          ...attachedFiles.map(f => `   • ${f.category}: ${f.name}`),
          "",
          `📝 CRM Updates:`,
          `   • tax_returns: status → "Sent to Accountant", accountant_status → "Sent - Pending"`,
          sd ? `   • Service delivery: stage → "Sent to be filed"` : `   • No active service delivery found`,
          "",
          missing.length > 0 ? `⚠️ Missing (sent anyway): ${missing.join(", ")}` : "",
          overrides.length > 0 ? `⚠️ Sent on your explicit choice: ${overrides.join("; ")}` : "",
          failedDownloads.length > 0 ? `⚠️ Could not download (NOT attached, NOT listed in the email): ${failedDownloads.join("; ")}` : "",
          excludedStatements.length > 0 ? `ℹ️ Statements left out (do not provably belong to ${tax_year}): ${excludedStatements.join(", ")}` : "",
          notes.length > 0 ? `⚠️ Files found but NOT used — check none of these was the one you meant: ${notes.join("; ")}` : "",
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
