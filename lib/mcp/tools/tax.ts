/**
 * Tax Return Tools — Search and track tax returns with visual dashboard.
 * Color-coded status tracking for tax season management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { localeFromLanguage } from "@/lib/locale"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { listFolder } from "@/lib/google-drive"
import { advanceStageIfAt } from "@/lib/operations/service-delivery"
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
        // contacts.language is free text ("Italian", not "it") — normalize.
        const formLang = language || localeFromLanguage(contact.language)

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
            // Read first: the chain advance below needs the row's account +
            // current status, and status is only moved forward from
            // pre-wizard states (never dragged back from Data Received etc.).
            const { data: trRow, error: selError } = await supabaseAdmin
              .from("tax_returns")
              .select("id, account_id, status")
              .eq("id", ext.tax_return_id)
              .eq("tax_year", tax_year)
              .maybeSingle()
            if (selError || !trRow) {
              errors.push(`${ext.tax_return_id}: ${selError?.message || "not found for that tax year"}`)
              failed++
              continue
            }

            const PRE_EXTENSION_STATUSES = ["Payment Pending", "Not Invoiced", "Paid - Not Started"]
            const { error } = await supabaseAdmin
              .from("tax_returns")
              .update({
                extension_filed: true,
                extension_confirmed_date: new Date().toISOString().slice(0, 10),
                extension_submission_id: ext.submission_id,
                // The extension IS a stage of the renewal chain (Antonio,
                // 2026-07-17) — recording it must move the record through
                // "Extension Filed", not just stamp the fields.
                ...(PRE_EXTENSION_STATUSES.includes(trRow.status as string) ? { status: "Extension Filed" } : {}),
              })
              .eq("id", ext.tax_return_id)
              .eq("tax_year", tax_year)

            if (error) {
              errors.push(`${ext.tax_return_id}: ${error.message}`)
              failed++
            } else {
              updated++
              // Advance the Tax Return SD chain to "Extension Filed" — only
              // from the pre-extension waiting stages; later stages are
              // untouched (advanceStageIfAt skips when the gate doesn't match).
              //
              // "Company Data Pending" MUST be in the gate. It is the LOWEST
              // tax stage (order -1) and the one the SD-bridge assigns for the
              // pre-payment statuses "Payment Pending" / "Not Invoiced"
              // (lib/operations/tax-return-sd-bridge.ts), so it is exactly
              // where a client sits before their first payment lands. Omitting
              // it stranded Bcom LLC for three months: their return went to
              // "Extension Filed" on 2026-04-12 while the SD silently stayed
              // put, and that stage makes the portal serve the COMPANY
              // INFORMATION form — so a company that already had its EIN was
              // asked for its company details and its tax questionnaire never
              // appeared. Found 2026-07-22.
              //
              // Safe for genuine standalone intake: those clients have a
              // CONTACT-scoped SD with account_id NULL and therefore no
              // tax_returns row, so this block never sees them (it is gated on
              // trRow.account_id and queries by account_id).
              if (trRow.account_id) {
                try {
                  const { data: sd } = await supabaseAdmin
                    .from("service_deliveries")
                    .select("id")
                    .eq("account_id", trRow.account_id)
                    .eq("service_type", "Tax Return")
                    .in("status", ["active", "on_hold"])
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle()
                  if (sd) {
                    await advanceStageIfAt({
                      delivery_id: sd.id,
                      if_current_stage: ["Company Data Pending", "1st Installment Paid", "Paid - Awaiting Data"],
                      target_stage: "Extension Filed",
                      actor: "tax-extension-update",
                      notes: `Extension filed for ${tax_year} (confirmation ${ext.submission_id})`,
                      skip_tasks: true,
                    })
                  }
                } catch {
                  // Chain advance is best-effort — the extension fields are
                  // already recorded; a stage hiccup must not fail the batch.
                }
              }
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

} // end registerTaxTools

function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  const now = new Date()
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}
