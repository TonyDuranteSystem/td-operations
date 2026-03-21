/**
 * Operations Tools — Task tracker, conversations, SOPs, service deliveries.
 * Visual dashboards for daily operations management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

export function registerOperationsTools(server: McpServer) {

  // ═══════════════════════════════════════
  // task_tracker
  // ═══════════════════════════════════════
  server.tool(
    "task_tracker",
    "PREFERRED tool for task overviews — use this ONE tool instead of multiple crm_search_tasks calls. Returns ALL open tasks grouped by priority (urgent/high/normal) with assignee breakdown and overdue alerts. Display results as markdown tables directly in chat — NEVER create files (docx/pdf/xlsx). Format: 🔴 URGENT table, 🔄 IN PROGRESS table, 🔵 NORMAL table.",
    {
      assigned_to: z.string().optional().describe("Filter by assignee name"),
      category: z.string().optional().describe("Filter by category"),
    },
    async ({ assigned_to, category }) => {
      try {
        let q = supabaseAdmin
          .from("tasks")
          .select("*, accounts(company_name)")
          .neq("status", "Cancelled")

        if (assigned_to) q = q.ilike("assigned_to", `%${assigned_to}%`)
        if (category) q = q.eq("category", category)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No tasks found." }] }
        }

        const today = new Date().toISOString().slice(0, 10)
        const open = data.filter(t => t.status !== "Done")
        const overdue = open.filter(t => t.due_date && t.due_date < today)

        const lines: string[] = [
          `═══════════════════════════════════════════════`,
          `  📋 TASK BOARD — ${data.length} tasks (${open.length} open)`,
          `═══════════════════════════════════════════════`,
          "",
        ]

        // Priority sections
        const priorities = ["Urgent", "High", "Normal", "Low"]
        const priorityIcons: Record<string, string> = {
          "Urgent": "🔴",
          "High": "🟠",
          "Normal": "🔵",
          "Low": "⚪",
        }

        for (const priority of priorities) {
          const tasks = data.filter(t => t.priority === priority)
          if (tasks.length === 0) continue

          const icon = priorityIcons[priority] || "•"
          const openCount = tasks.filter(t => t.status !== "Done").length

          lines.push(`  ${icon} ${priority.toUpperCase()} (${tasks.length} total, ${openCount} open)`)

          // Status breakdown within priority
          const statuses = ["To Do", "In Progress", "Waiting", "Done"]
          const statusIcons: Record<string, string> = {
            "To Do": "⬜",
            "In Progress": "🔄",
            "Waiting": "⏳",
            "Done": "✅",
          }

          for (const status of statuses) {
            const count = tasks.filter(t => t.status === status).length
            if (count === 0) continue
            const action = status === "To Do" ? "  ← ACTION NEEDED" : ""
            lines.push(`     ${statusIcons[status]} ${status} ${"·".repeat(Math.max(1, 25 - status.length))} ${count}${action}`)
          }

          // Show individual urgent/high To Do items
          if ((priority === "Urgent" || priority === "High") && openCount > 0) {
            const todoItems = tasks.filter(t => t.status === "To Do" || t.status === "In Progress")
            if (todoItems.length > 0) {
              lines.push("")
              for (const t of todoItems.slice(0, 8)) {
                const acct = t.accounts as { company_name?: string } | null
                const company = acct?.company_name ? ` [${acct.company_name}]` : ""
                const due = t.due_date ? ` due:${t.due_date}` : ""
                const overdueFlag = t.due_date && t.due_date < today ? " 🔴" : ""
                lines.push(`     • ${t.task_title}${company}${due}${overdueFlag}`)
              }
              if (todoItems.length > 8) lines.push(`     ... +${todoItems.length - 8} more`)
            }
          }

          lines.push("")
        }

        // Assignee breakdown
        const assignees: Record<string, { total: number; open: number; overdue: number }> = {}
        for (const t of data) {
          const a = t.assigned_to || "Unassigned"
          if (!assignees[a]) assignees[a] = { total: 0, open: 0, overdue: 0 }
          assignees[a].total++
          if (t.status !== "Done") assignees[a].open++
          if (t.due_date && t.due_date < today && t.status !== "Done") assignees[a].overdue++
        }

        lines.push(`  👤 BY ASSIGNEE`)
        lines.push(`  ─────────────────────────────────────`)
        for (const [name, counts] of Object.entries(assignees).sort((a, b) => b[1].open - a[1].open)) {
          const overdueLabel = counts.overdue > 0 ? ` 🔴 ${counts.overdue} overdue` : ""
          lines.push(`     ${name} ${"·".repeat(Math.max(1, 20 - name.length))} ${counts.open} open / ${counts.total} total${overdueLabel}`)
        }

        // Category breakdown
        const categories: Record<string, number> = {}
        for (const t of open) {
          const cat = t.category || "Uncategorized"
          categories[cat] = (categories[cat] || 0) + 1
        }

        if (Object.keys(categories).length > 0) {
          lines.push("")
          lines.push(`  📂 BY CATEGORY (open only)`)
          lines.push(`  ─────────────────────────────────────`)
          for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
            lines.push(`     ${cat} ${"·".repeat(Math.max(1, 25 - cat.length))} ${count}`)
          }
        }

        // Overdue section
        if (overdue.length > 0) {
          lines.push("")
          lines.push(`  ⚠️ OVERDUE (${overdue.length})`)
          lines.push(`  ─────────────────────────────────────`)
          for (const t of overdue.slice(0, 10)) {
            const acct = t.accounts as { company_name?: string } | null
            const company = acct?.company_name ? ` [${acct.company_name}]` : ""
            const daysLate = Math.ceil((new Date().getTime() - new Date(t.due_date).getTime()) / (1000 * 60 * 60 * 24))
            lines.push(`     🔴 ${t.task_title}${company} — ${daysLate}d late (${t.assigned_to || "?"})`)
          }
          if (overdue.length > 10) lines.push(`     ... +${overdue.length - 10} more`)
        }

        // Summary line
        lines.push("")
        lines.push(`  ─────────────────────────────────────`)
        lines.push(`  Total: ${data.length} | Open: ${open.length} | Overdue: ${overdue.length}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_create_task
  // ═══════════════════════════════════════
  server.tool(
    "crm_create_task",
    "Create a new task/ticket. Assign to a team member, set priority and category, link to an account/deal/service. Returns the created task with ID.",
    {
      task_title: z.string().describe("Task title"),
      assigned_to: z.string().describe("Assignee name (e.g., 'Luca', 'Antonio')"),
      priority: z.string().optional().describe("Priority: Urgent, High, Normal (default), Low"),
      category: z.string().optional().describe("Category: Client Response, Document, Filing, Follow-up, Payment, CRM Update, Internal, KYC, Shipping, Notarization, Client Communication, Formation"),
      due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
      description: z.string().optional().describe("Task description/details"),
      account_id: z.string().uuid().optional().describe("Link to account UUID"),
      deal_id: z.string().uuid().optional().describe("Link to deal UUID"),
      service_id: z.string().uuid().optional().describe("Link to service UUID (services table)"),
      delivery_id: z.string().uuid().optional().describe("Link to service delivery UUID (service_deliveries table, for pipeline tracking)"),
      stage_order: z.number().optional().describe("Pipeline stage_order (auto-set by sd_advance_stage, rarely needed manually)"),
      status: z.string().optional().describe("Initial status: To Do (default), In Progress, Waiting"),
    },
    async ({ task_title, assigned_to, priority, category, due_date, description, account_id, deal_id, service_id, delivery_id, stage_order, status }) => {
      try {
        const insert: Record<string, unknown> = {
          task_title,
          assigned_to,
          priority: priority || "Normal",
          category: category || null,
          due_date: due_date || null,
          description: description || null,
          account_id: account_id || null,
          deal_id: deal_id || null,
          service_id: service_id || null,
          delivery_id: delivery_id || null,
          stage_order: stage_order || null,
          status: status || "To Do",
          created_by: "Claude",
        }

        const { data, error } = await supabaseAdmin
          .from("tasks")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "create",
          table_name: "tasks",
          record_id: data.id,
          account_id: account_id || undefined,
          summary: `Task created: ${task_title} → ${assigned_to}`,
          details: { task_title, assigned_to, priority: priority || "Normal", category },
        })

        // ─── Send email notification to assignee ───
        const ASSIGNEE_EMAILS: Record<string, string> = {
          "Luca": "support@tonydurante.us",
          "Antonio": "antonio.durante@tonydurante.us",
          "Claude": "", // no self-notification
        }
        const assigneeEmail = ASSIGNEE_EMAILS[assigned_to]
        if (assigneeEmail) {
          try {
            const { gmailPost } = await import("@/lib/gmail")
            const taskPriority = priority || "Normal"
            const priorityTag = taskPriority === "Urgent" ? "[URGENT]" : taskPriority === "High" ? "[HIGH]" : "[TASK]"
            const priorityColor = taskPriority === "Urgent" ? "#dc2626" : taskPriority === "High" ? "#ea580c" : "#2563eb"

            // Get company name if account_id provided
            let companyName = ""
            if (account_id) {
              const { data: acc } = await supabaseAdmin.from("accounts").select("company_name").eq("id", account_id).single()
              if (acc) companyName = acc.company_name
            }

            const subject = `${priorityTag} ${task_title}${companyName ? " - " + companyName : ""}`
            const body = [
              `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">`,
              `<h2 style="margin:0 0 12px;color:${priorityColor}">${priorityTag} ${task_title}</h2>`,
              companyName ? `<p><strong>Client:</strong> ${companyName}</p>` : "",
              `<p><strong>Assigned to:</strong> ${assigned_to}</p>`,
              `<p><strong>Priority:</strong> ${taskPriority}</p>`,
              due_date ? `<p><strong>Due:</strong> ${due_date}</p>` : "",
              category ? `<p><strong>Category:</strong> ${category}</p>` : "",
              description ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/><p>${description.replace(/\n/g, "<br/>")}</p>` : "",
              `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>`,
              `<p style="font-size:12px;color:#6b7280">Task ID: ${data.id}<br/>View in CRM: <a href="${process.env.NEXT_PUBLIC_APP_URL || ""}/tasks">Task Board</a></p>`,
              `</div>`,
            ].filter(Boolean).join("\n")

            const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
            const raw = Buffer.from(
              `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
              `To: ${assigneeEmail}\r\n` +
              `Subject: ${encodedSubject}\r\n` +
              `MIME-Version: 1.0\r\n` +
              `Content-Type: text/html; charset=utf-8\r\n\r\n` +
              body
            ).toString("base64url")

            await gmailPost("/messages/send", { raw })
          } catch {
            // Email notification failure is non-blocking
          }
        }

        return { content: [{ type: "text" as const, text: `✅ Task created: ${data.task_title}\nAssigned: ${data.assigned_to} | Priority: ${data.priority} | Due: ${data.due_date || "—"}\nID: ${data.id}${assigneeEmail ? `\n📧 Notification sent to ${assigneeEmail}` : ""}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_create_account
  // ═══════════════════════════════════════
  server.tool(
    "crm_create_account",
    "Create a new CRM account (company/LLC). Use this when onboarding a new client after lead conversion. If lead_id is provided, account_type is auto-derived from the offer (annual installments → Client, no installments → One-Time), and referral info is auto-populated from lead/offer if present. Returns the created account with ID.",
    {
      company_name: z.string().describe("Company/LLC name"),
      entity_type: z.string().optional().describe("Entity type (e.g., Single Member LLC, Multi-Member LLC, Corporation)"),
      state_of_formation: z.string().optional().describe("State of formation (e.g., Wyoming, Delaware, Florida)"),
      lead_id: z.string().uuid().optional().describe("Lead UUID — auto-derives account_type + referral from offer/lead"),
      account_type: z.enum(["Client", "One-Time"]).optional().describe("Client = annual management, One-Time = single service. Auto-derived from lead if lead_id provided."),
      status: z.string().optional().describe("Account status (default: Active)"),
      ein: z.string().optional().describe("EIN number (e.g., 30-1482516)"),
      formation_date: z.string().optional().describe("Formation date (YYYY-MM-DD)"),
      notes: z.string().optional().describe("Account notes"),
      referrer: z.string().optional().describe("Referrer name (client or partner who referred)"),
      referred_by: z.string().uuid().optional().describe("Referrer's account UUID (partner or client account)"),
      referral_commission_pct: z.number().optional().describe("Referral commission % (default 10 for client referrals)"),
    },
    async ({ company_name, entity_type, state_of_formation, lead_id, account_type, status, ein, formation_date, notes, referrer, referred_by, referral_commission_pct }) => {
      try {
        // Check for duplicates
        const { data: existing } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, status")
          .ilike("company_name", `%${company_name}%`)
          .limit(3)

        if (existing && existing.length > 0) {
          const dupes = existing.map(e => `• ${e.company_name} (${e.status}) — ${e.id}`).join("\n")
          return { content: [{ type: "text" as const, text: `⚠️ Possible duplicates found:\n${dupes}\n\nIf this is a new account, use a more specific name or proceed with crm_update_record on the existing one.` }] }
        }

        // Auto-derive account_type + installments from CONTRACTS (source of truth) if lead_id provided
        let resolvedAccountType = account_type || "Client"
        let inst1Amount: number | null = null
        let inst2Amount: number | null = null
        let instCurrency = "USD"
        if (lead_id) {
          // Find signed contract via offer linked to this lead
          const { data: offerForLead } = await supabaseAdmin
            .from("offers")
            .select("token")
            .eq("lead_id", lead_id)
            .eq("status", "signed")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()

          if (offerForLead?.token) {
            const { data: contract } = await supabaseAdmin
              .from("contracts")
              .select("annual_fee, installments")
              .eq("offer_token", offerForLead.token)
              .eq("status", "signed")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()

            if (contract) {
              // Parse installments from contract JSON {"jan":1000,"jun":1000}
              if (contract.installments) {
                try {
                  const inst = typeof contract.installments === "string"
                    ? JSON.parse(contract.installments) : contract.installments
                  if (inst.jan && inst.jan > 0) inst1Amount = inst.jan
                  if (inst.jun && inst.jun > 0) inst2Amount = inst.jun
                } catch { /* ignore parse errors */ }
              }

              // Derive account_type from installments (only if not explicitly set)
              if (!account_type) {
                const hasAnnual = (inst1Amount && inst1Amount > 0) || (inst2Amount && inst2Amount > 0)
                  || (contract.annual_fee && parseFloat(contract.annual_fee) > 0)
                resolvedAccountType = hasAnnual ? "Client" : "One-Time"
              }
            }
          }
        }

        // Auto-lookup referral from lead/offer if lead_id provided and no explicit referrer
        let refName = referrer || null
        let refBy = referred_by || null
        let refPct = referral_commission_pct ?? null
        let refStatus: string | null = null
        let referralAutoFilled = false

        if (lead_id && !referrer) {
          const { data: leadRef } = await supabaseAdmin
            .from("leads")
            .select("referrer_name, referrer_partner_id")
            .eq("id", lead_id)
            .maybeSingle()

          if (leadRef?.referrer_name) {
            refName = leadRef.referrer_name
            refBy = leadRef.referrer_partner_id || null
            referralAutoFilled = true

            // Check offer for detailed commission info
            const { data: offerRef } = await supabaseAdmin
              .from("offers")
              .select("referrer_name, referrer_account_id, referrer_commission_pct, referrer_type")
              .eq("lead_id", lead_id)
              .not("referrer_name", "is", null)
              .limit(1)
              .maybeSingle()

            if (offerRef) {
              refName = offerRef.referrer_name || refName
              refBy = offerRef.referrer_account_id || refBy
              refPct = offerRef.referrer_commission_pct ?? 10
            } else {
              refPct = 10
            }
            refStatus = "pending"
          }
        }

        if (refName && refStatus === null) {
          refStatus = "pending"
        }

        const insert: Record<string, unknown> = {
          company_name,
          entity_type: entity_type || null,
          state_of_formation: state_of_formation || null,
          account_type: resolvedAccountType,
          status: status || "Active",
          ein_number: ein || null,
          formation_date: formation_date || null,
          notes: notes || null,
          ...(inst1Amount != null && { installment_1_amount: inst1Amount, installment_1_currency: instCurrency }),
          ...(inst2Amount != null && { installment_2_amount: inst2Amount, installment_2_currency: instCurrency }),
          referrer: refName,
          referred_by: refBy,
          referral_commission_pct: refPct,
          referral_status: refStatus,
        }

        const { data, error } = await supabaseAdmin
          .from("accounts")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "create",
          table_name: "accounts",
          record_id: data.id,
          summary: `Account created: ${company_name} (${state_of_formation || "no state"}, ${resolvedAccountType})${refName ? ` — referral: ${refName}` : ""}`,
          details: { company_name, entity_type, state_of_formation, account_type: resolvedAccountType, status: status || "Active", referrer: refName, referral_commission_pct: refPct },
        })

        const referralLine = refName
          ? `\n📎 Referral: ${refName}${refPct ? ` (${refPct}%)` : ""} — status: ${refStatus}${referralAutoFilled ? " (auto-filled from lead)" : ""}`
          : ""

        return { content: [{ type: "text" as const, text: `✅ Account created: ${data.company_name}\nStatus: ${data.status} | Type: ${resolvedAccountType} | State: ${data.state_of_formation || "—"}\nID: ${data.id}${referralLine}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_create_contact
  // ═══════════════════════════════════════
  server.tool(
    "crm_create_contact",
    "Create a new CRM contact (person). After creation, link to an account using crm_update_record on the account_contacts junction table, or provide account_id to auto-link.",
    {
      full_name: z.string().describe("Full name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      citizenship: z.string().optional().describe("Citizenship/nationality"),
      language: z.string().optional().describe("Preferred language"),
      account_id: z.string().uuid().optional().describe("Auto-link to this account after creation"),
      role: z.string().optional().describe("Role in the company (e.g., Owner, Member, Manager)"),
    },
    async ({ full_name, email, phone, citizenship, language, account_id, role }) => {
      try {
        // Check for duplicates
        if (email) {
          const { data: existing } = await supabaseAdmin
            .from("contacts")
            .select("id, full_name")
            .ilike("email", email)
            .limit(1)

          if (existing && existing.length > 0) {
            return { content: [{ type: "text" as const, text: `⚠️ Contact with email ${email} already exists: ${existing[0].full_name} — ID: ${existing[0].id}` }] }
          }
        }

        const nameParts = full_name.trim().split(/\s+/)
        const insert: Record<string, unknown> = {
          full_name: full_name.trim(),
          first_name: nameParts[0],
          last_name: nameParts.length > 1 ? nameParts.slice(1).join(" ") : null,
          email: email || null,
          phone: phone || null,
          citizenship: citizenship || null,
          language: language || null,
        }

        const { data, error } = await supabaseAdmin
          .from("contacts")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        // Auto-link to account if provided
        if (account_id) {
          await supabaseAdmin
            .from("account_contacts")
            .insert({
              account_id,
              contact_id: data.id,
              role: role || "Owner",
            })
        }

        logAction({
          action_type: "create",
          table_name: "contacts",
          record_id: data.id,
          account_id: account_id || undefined,
          summary: `Contact created: ${full_name}${account_id ? " (linked to account)" : ""}`,
          details: { full_name, email, phone, citizenship, account_id },
        })

        const linked = account_id ? ` | Linked to account: ${account_id}` : ""
        return { content: [{ type: "text" as const, text: `✅ Contact created: ${data.full_name}\nEmail: ${data.email || "—"} | Phone: ${data.phone || "—"}${linked}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // conv_log
  // ═══════════════════════════════════════
  server.tool(
    "conv_log",
    "Log a client conversation/interaction in the CRM. Use after handling a WhatsApp, email, or call to maintain communication history. Links to account, contact, and optionally a deal.",
    {
      account_id: z.string().uuid().optional().describe("Account UUID"),
      contact_id: z.string().uuid().optional().describe("Contact UUID"),
      deal_id: z.string().uuid().optional().describe("Deal UUID (if related to a deal)"),
      channel: z.string().optional().describe("Channel: WhatsApp, Email, Phone, Calendly, Telegram"),
      topic: z.string().describe("Brief topic/subject of the conversation"),
      category: z.string().optional().describe("Category (e.g., Support, Billing, Onboarding, Tax)"),
      client_message: z.string().optional().describe("Summary of what the client said"),
      response_sent: z.string().optional().describe("Summary of the response sent"),
      response_language: z.string().optional().describe("Language of the response (en, it)"),
      direction: z.enum(["Inbound", "Outbound"]).optional().describe("Direction: Inbound or Outbound"),
      handled_by: z.string().optional().describe("Who handled it (Antonio, Luca, Claude)"),
      internal_notes: z.string().optional().describe("Internal notes (not visible to client)"),
    },
    async ({ account_id, contact_id, deal_id, channel, topic, category, client_message, response_sent, response_language, direction, handled_by, internal_notes }) => {
      try {
        const insert: Record<string, unknown> = {
          account_id: account_id || null,
          contact_id: contact_id || null,
          deal_id: deal_id || null,
          channel: channel || null,
          topic,
          category: category || null,
          client_message: client_message || null,
          response_sent: response_sent || null,
          response_language: response_language || null,
          direction: direction || null,
          handled_by: handled_by || "Claude",
          internal_notes: internal_notes || null,
          status: response_sent ? "Sent" : "New",
        }

        const { data, error } = await supabaseAdmin
          .from("conversations")
          .insert(insert)
          .select("id")
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "create",
          table_name: "conversations",
          record_id: data.id,
          account_id: account_id || undefined,
          summary: `Conversation logged: ${topic} (${channel || "no channel"})`,
          details: { topic, channel, direction, handled_by: handled_by || "Claude", category },
        })

        return { content: [{ type: "text" as const, text: `✅ Conversation logged: ${topic}\nChannel: ${channel || "—"} | Handled by: ${handled_by || "Claude"}\nID: ${data.id}` }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // conv_search
  // ═══════════════════════════════════════
  server.tool(
    "conv_search",
    "Search conversation history by account, contact, channel, category, or date range. Returns conversation log with topic, channel, and response summary. Use this to check what was discussed with a client.",
    {
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      contact_id: z.string().uuid().optional().describe("Filter by contact UUID"),
      channel: z.string().optional().describe("Channel: WhatsApp, Email, Phone, Calendly, Telegram"),
      category: z.string().optional().describe("Category filter"),
      query: z.string().optional().describe("Search text in topic or client_message"),
      date_from: z.string().optional().describe("From date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("To date (YYYY-MM-DD)"),
      limit: z.number().optional().default(25).describe("Max results (default 25)"),
    },
    async ({ account_id, contact_id, channel, category, query, date_from, date_to, limit }) => {
      try {
        let q = supabaseAdmin
          .from("conversations")
          .select("*, accounts(company_name)")
          .order("date", { ascending: false })
          .limit(Math.min(limit || 25, 100))

        if (account_id) q = q.eq("account_id", account_id)
        if (contact_id) q = q.eq("contact_id", contact_id)
        if (channel) q = q.eq("channel", channel)
        if (category) q = q.eq("category", category)
        if (query) q = q.or(`topic.ilike.%${query}%,client_message.ilike.%${query}%`)
        if (date_from) q = q.gte("date", `${date_from}T00:00:00`)
        if (date_to) q = q.lte("date", `${date_to}T23:59:59`)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No conversations found." }] }
        }

        const channelIcons: Record<string, string> = {
          "WhatsApp": "💬",
          "Email": "📧",
          "Phone": "📞",
          "Calendly": "📅",
          "Telegram": "✈️",
        }

        const lines: string[] = [`💬 Conversations (${data.length})`, ""]

        for (const c of data) {
          const acct = c.accounts as { company_name?: string } | null
          const icon = channelIcons[c.channel] || "💬"
          const date = c.date ? new Date(c.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?"
          const company = acct?.company_name ? ` [${acct.company_name}]` : ""

          lines.push(`${icon} ${c.topic}${company}`)
          lines.push(`   ${date} | ${c.channel || "?"} | ${c.handled_by || "?"} | ${c.status || "?"}`)
          if (c.client_message) {
            const preview = c.client_message.length > 100 ? c.client_message.slice(0, 100) + "..." : c.client_message
            lines.push(`   Client: ${preview}`)
          }
          if (c.response_sent) {
            const preview = c.response_sent.length > 100 ? c.response_sent.slice(0, 100) + "..." : c.response_sent
            lines.push(`   Response: ${preview}`)
          }
          lines.push(`   ID: ${c.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sop_search
  // ═══════════════════════════════════════
  server.tool(
    "sop_search",
    "Search Standard Operating Procedures (SOPs/runbooks) by title, service type, or content. Returns SOP title, service type, and content preview. SOPs contain step-by-step procedures for service delivery.",
    {
      query: z.string().optional().describe("Search text (matches title and content)"),
      service_type: z.string().optional().describe("Service type filter"),
    },
    async ({ query, service_type }) => {
      try {
        let q = supabaseAdmin
          .from("sop_runbooks")
          .select("*")
          .order("title")

        if (query) q = q.or(`title.ilike.%${query}%,content.ilike.%${query}%`)
        if (service_type) q = q.eq("service_type", service_type)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No SOPs found." }] }
        }

        const lines: string[] = [`📘 SOPs (${data.length})`, ""]

        for (const sop of data) {
          const preview = sop.content.length > 200 ? sop.content.slice(0, 200) + "..." : sop.content
          lines.push(`📘 ${sop.title}`)
          if (sop.service_type) lines.push(`   Service: ${sop.service_type}`)
          if (sop.version) lines.push(`   Version: ${sop.version}`)
          lines.push(`   ${preview}`)
          lines.push(`   ID: ${sop.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sop_get
  // ═══════════════════════════════════════
  server.tool(
    "sop_get",
    "Get full SOP/runbook content by ID. Returns complete step-by-step procedure. Use sop_search first to find the ID.",
    {
      id: z.string().uuid().describe("SOP UUID (from sop_search)"),
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("sop_runbooks")
          .select("*")
          .eq("id", id)
          .single()

        if (error || !data) {
          return { content: [{ type: "text" as const, text: `SOP not found: ${id}` }] }
        }

        const lines: string[] = [
          `📘 ${data.title}`,
          "",
          `Service: ${data.service_type || "—"}`,
          `Version: ${data.version || "—"}`,
          "",
          data.content,
        ]

        if (data.notes) {
          lines.push("", "── Notes ──", data.notes)
        }

        lines.push("", `ID: ${data.id}`)

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sd_search (service deliveries)
  // ═══════════════════════════════════════
  server.tool(
    "sd_search",
    "Search service delivery records (detailed execution pipeline). Different from crm_search_services — this tracks individual delivery steps with stages like 'EIN Submitted', 'Articles Filed'. Returns service name, type, stage, status, assigned_to, and dates.",
    {
      service_type: z.string().optional().describe("Service type filter"),
      stage: z.string().optional().describe("Current stage filter"),
      status: z.string().optional().describe("Status: active, completed, cancelled"),
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      contact_id: z.string().uuid().optional().describe("Filter by contact UUID (for individual clients without account)"),
      pipeline: z.string().optional().describe("Pipeline filter"),
      assigned_to: z.string().optional().describe("Assignee name"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ service_type, stage, status, account_id, contact_id, pipeline, assigned_to, limit }) => {
      try {
        let q = supabaseAdmin
          .from("service_deliveries")
          .select("*, accounts(company_name)")
          .order("updated_at", { ascending: false })
          .limit(Math.min(limit || 50, 200))

        if (service_type) q = q.ilike("service_type", `%${service_type}%`)
        if (stage) q = q.ilike("stage", `%${stage}%`)
        if (status) q = q.eq("status", status)
        if (account_id) q = q.eq("account_id", account_id)
        if (contact_id) q = q.eq("contact_id", contact_id)
        if (pipeline) q = q.ilike("pipeline", `%${pipeline}%`)
        if (assigned_to) q = q.ilike("assigned_to", `%${assigned_to}%`)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No service deliveries found." }] }
        }

        const lines: string[] = [`⚙️ Service Deliveries (${data.length})`, ""]

        for (const sd of data) {
          const acct = sd.accounts as { company_name?: string } | null
          const company = acct?.company_name || "?"
          const progress = sd.total_steps ? `${sd.current_step || 0}/${sd.total_steps}` : ""

          lines.push(`⚙️ ${sd.service_name} [${company}]`)
          lines.push(`   Type: ${sd.service_type} | Stage: ${sd.stage || "—"} | Status: ${sd.status || "—"}`)
          if (progress) lines.push(`   Progress: ${progress}`)
          if (sd.assigned_to) lines.push(`   Assigned: ${sd.assigned_to}`)
          if (sd.due_date) lines.push(`   Due: ${sd.due_date}`)
          lines.push(`   ID: ${sd.id}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sd_pipeline
  // ═══════════════════════════════════════
  server.tool(
    "sd_pipeline",
    "Visual pipeline summary for service deliveries — shows count by stage for a given service type. Like a Kanban board in text form. Use this to see how many LLC formations are at each stage, or how many EIN applications are pending.",
    {
      service_type: z.string().describe("Service type to show pipeline for (e.g., 'LLC Formation', 'EIN', 'ITIN', 'Tax Return')"),
    },
    async ({ service_type }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("service_deliveries")
          .select("stage, status")
          .ilike("service_type", `%${service_type}%`)
          .eq("status", "active")

        if (error) throw new Error(error.message)
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: `No active deliveries for "${service_type}".` }] }
        }

        const byStage: Record<string, number> = {}
        for (const d of data) {
          const stage = d.stage || "Unknown"
          byStage[stage] = (byStage[stage] || 0) + 1
        }

        const total = data.length
        const lines: string[] = [
          `═══════════════════════════════════════════════`,
          `  ⚙️ ${service_type.toUpperCase()} PIPELINE (${total} active)`,
          `═══════════════════════════════════════════════`,
          "",
        ]

        // Sort stages and display as visual bars
        const sorted = Object.entries(byStage).sort((a, b) => b[1] - a[1])
        const maxCount = sorted[0]?.[1] || 1

        for (const [stage, count] of sorted) {
          const barLen = Math.max(1, Math.round((count / maxCount) * 25))
          const bar = "█".repeat(barLen)
          const pct = Math.round((count / total) * 100)
          lines.push(`  ${bar} ${count} (${pct}%)`)
          lines.push(`  ${stage}`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sd_advance_stage
  // ═══════════════════════════════════════
  server.tool(
    "sd_advance_stage",
    "Advance a service delivery to the next pipeline stage. Automatically creates tasks defined in pipeline_stages.auto_tasks for the new stage. Returns the new stage, created tasks, and any stage that requires_approval. Use sd_search to find the delivery ID first. If skip_tasks=true, advances without creating tasks.",
    {
      delivery_id: z.string().uuid().describe("Service delivery UUID"),
      target_stage: z.string().optional().describe("Specific stage name to advance to (skips intermediate). If omitted, advances to next stage."),
      skip_tasks: z.boolean().optional().default(false).describe("Skip auto-task creation (default: false)"),
      notes: z.string().optional().describe("Notes about why this stage was advanced"),
    },
    async ({ delivery_id, target_stage, skip_tasks, notes }) => {
      try {
        // 1. Get current delivery
        const { data: delivery, error: dErr } = await supabaseAdmin
          .from("service_deliveries")
          .select("*")
          .eq("id", delivery_id)
          .single()
        if (dErr || !delivery) throw new Error("Service delivery not found")

        // 2. Get pipeline stages for this service type
        const { data: stages, error: sErr } = await supabaseAdmin
          .from("pipeline_stages")
          .select("*")
          .eq("service_type", delivery.service_type)
          .order("stage_order")
        if (sErr || !stages?.length) throw new Error(`No pipeline stages defined for service_type: ${delivery.service_type}`)

        // 3. Determine current and target stage
        const currentOrder = delivery.stage_order || 0
        let targetStage: typeof stages[0]

        if (target_stage) {
          const found = stages.find(s => s.stage_name.toLowerCase() === target_stage.toLowerCase())
          if (!found) throw new Error(`Stage "${target_stage}" not found. Available: ${stages.map(s => s.stage_name).join(", ")}`)
          targetStage = found
        } else {
          const nextStage = stages.find(s => s.stage_order > currentOrder)
          if (!nextStage) throw new Error("Already at final stage")
          targetStage = nextStage
        }

        // 4. Check if current stage requires approval
        if (currentOrder > 0) {
          const currentStageObj = stages.find(s => s.stage_order === currentOrder)
          if (currentStageObj?.requires_approval) {
            // Check if there's an open approval task
            const { data: approvalTasks } = await supabaseAdmin
              .from("tasks")
              .select("id, status")
              .eq("account_id", delivery.account_id)
              .ilike("task_title", `%quality check%`)
              .in("status", ["todo", "in_progress"])
              .limit(1)
            if (approvalTasks?.length) {
              return { content: [{ type: "text" as const, text: `⚠️ Current stage "${currentStageObj.stage_name}" requires approval. Complete the approval task first, or use target_stage to force advance.` }] }
            }
          }
        }

        // 5. Build stage history entry
        const historyEntry = {
          from_stage: delivery.stage || "New",
          from_order: currentOrder,
          to_stage: targetStage.stage_name,
          to_order: targetStage.stage_order,
          advanced_at: new Date().toISOString(),
          notes: notes || null,
        }
        const stageHistory = Array.isArray(delivery.stage_history) ? [...delivery.stage_history, historyEntry] : [historyEntry]

        // 6. Update delivery
        const isCompleted = targetStage.stage_name === "Completed" || targetStage.stage_name === "TR Filed"
        const { error: uErr } = await supabaseAdmin
          .from("service_deliveries")
          .update({
            stage: targetStage.stage_name,
            stage_order: targetStage.stage_order,
            stage_entered_at: new Date().toISOString(),
            stage_history: stageHistory,
            status: isCompleted ? "completed" : "active",
            ...(isCompleted ? { end_date: new Date().toISOString().split("T")[0] } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", delivery_id)
        if (uErr) throw new Error(`Update failed: ${uErr.message}`)

        // 7. Create auto-tasks (unless skipped)
        const createdTasks: string[] = []
        const failedTasks: { title: string; error: string }[] = []
        if (!skip_tasks && targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
          for (const taskDef of targetStage.auto_tasks as Array<{ title: string; assigned_to: string; category: string; priority: string; description?: string }>) {
            const { error: tErr } = await supabaseAdmin
              .from("tasks")
              .insert({
                task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
                assigned_to: taskDef.assigned_to || "Luca",
                category: taskDef.category || "Internal",
                priority: taskDef.priority || "Normal",
                description: taskDef.description || `Auto-created by pipeline advance to "${targetStage.stage_name}"`,
                status: "To Do",
                account_id: delivery.account_id,
                deal_id: delivery.deal_id,
                delivery_id: delivery.id,
                stage_order: targetStage.stage_order,
              })
            if (tErr) {
              failedTasks.push({ title: taskDef.title, error: tErr.message })
            } else {
              createdTasks.push(taskDef.title)
            }
          }
        }

        // 7b. Check portal tier upgrade: active → full
        // Triggers: EIN received (stage_order >= 4 in formation), or service completed
        if (delivery.account_id) {
          const shouldUpgradeToFull = isCompleted
            || targetStage.stage_name === "EIN Received"
            || targetStage.stage_name === "Welcome Package"
            || targetStage.stage_order >= 8 // Late-stage milestone

          if (shouldUpgradeToFull) {
            const { data: acct } = await supabaseAdmin
              .from("accounts")
              .select("portal_tier")
              .eq("id", delivery.account_id)
              .single()

            if (acct?.portal_tier === "active") {
              await supabaseAdmin
                .from("accounts")
                .update({ portal_tier: "full", updated_at: new Date().toISOString() })
                .eq("id", delivery.account_id)
            }
          }
        }

        // 8. Format response with structured status
        const overallStatus = failedTasks.length > 0 ? "partial" : "success"
        const statusIcon = failedTasks.length > 0 ? "⚠️" : "✅"
        const lines = [
          `${statusIcon} Advanced to: **${targetStage.stage_name}** (stage ${targetStage.stage_order}/${stages.length})`,
          `📋 Service: ${delivery.service_name || delivery.service_type}`,
          `🔄 From: ${delivery.stage || "New"} → ${targetStage.stage_name}`,
          `Overall: ${overallStatus}`,
        ]
        if (targetStage.sla_days) lines.push(`⏱️ SLA: ${targetStage.sla_days} days`)
        if (targetStage.requires_approval) lines.push(`🔒 This stage requires approval before advancing`)
        if (createdTasks.length > 0) {
          lines.push(`\n📝 Auto-created ${createdTasks.length} tasks:`)
          for (const t of createdTasks) lines.push(`  ✅ ${t}`)
        }
        if (failedTasks.length > 0) {
          lines.push(`\n❌ Failed to create ${failedTasks.length} tasks:`)
          for (const t of failedTasks) lines.push(`  ❌ ${t.title} — ${t.error}`)
        }
        if (isCompleted) lines.push(`\n🎉 Service delivery marked as COMPLETED`)

        logAction({
          action_type: "advance",
          table_name: "service_deliveries",
          record_id: delivery_id,
          account_id: delivery.account_id || undefined,
          summary: `Stage advanced: ${delivery.stage || "New"} → ${targetStage.stage_name} (${delivery.service_name || delivery.service_type})`,
          details: { from_stage: delivery.stage, to_stage: targetStage.stage_name, tasks_created: createdTasks, notes },
        })

        // ─── AUTO-TRIGGER: Portal notification for client ───
        if (delivery.account_id) {
          const { createPortalNotification } = await import("@/lib/portal/notifications")
          const title = isCompleted
            ? `${delivery.service_name || delivery.service_type} is complete!`
            : `${delivery.service_name || delivery.service_type} update`
          const body = isCompleted
            ? "Your service has been completed."
            : `Status updated to: ${targetStage.stage_name}`
          createPortalNotification({
            account_id: delivery.account_id,
            type: "service",
            title,
            body,
            link: "/portal/services",
          }).catch(() => {})
        }

        // ─── AUTO-TRIGGER: Tax Return — sync tax_returns record with SD stage ───
        if (delivery.service_type === "Tax Return Filing" && delivery.account_id) {
          try {
            const taxYear = new Date().getFullYear()
            const { data: tr } = await supabaseAdmin
              .from("tax_returns")
              .select("id, status")
              .eq("account_id", delivery.account_id)
              .eq("tax_year", taxYear)
              .maybeSingle()

            if (tr) {
              const stageToStatus: Record<string, string> = {
                "Payment Verified": "Activated - Need Link",
                "Data Link Sent": "Link Sent - Awaiting Data",
                "Extension Requested": "Extension Requested",
                "Extension Filed": "Extension Filed",
                "Data Received": "Data Received",
                "Preparation - Sent to India": "Sent to India",
                "TR Completed": "TR Completed - Awaiting Signature",
                "TR Filed": "TR Filed",
              }
              const newStatus = stageToStatus[targetStage.stage_name]
              if (newStatus && newStatus !== tr.status) {
                const trUpdates: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() }

                // Set date fields based on stage
                if (targetStage.stage_name === "Extension Requested") {
                  trUpdates.extension_requested_date = new Date().toISOString().slice(0, 10)
                } else if (targetStage.stage_name === "Extension Filed") {
                  trUpdates.extension_filed = true
                  trUpdates.extension_confirmed_date = new Date().toISOString().slice(0, 10)
                } else if (targetStage.stage_name === "Data Received") {
                  trUpdates.data_received = true
                  trUpdates.data_received_date = new Date().toISOString().slice(0, 10)
                } else if (targetStage.stage_name === "Preparation - Sent to India") {
                  trUpdates.sent_to_india = true
                  trUpdates.sent_to_india_date = new Date().toISOString().slice(0, 10)
                  trUpdates.india_status = "Sent - Pending"
                }

                await supabaseAdmin
                  .from("tax_returns")
                  .update(trUpdates)
                  .eq("id", tr.id)

                lines.push(`\n📊 Tax return synced: ${tr.status} → ${newStatus}`)
              }
            }
          } catch (trErr) {
            lines.push(`\n⚠️ Tax return sync failed: ${trErr instanceof Error ? trErr.message : String(trErr)}`)
          }
        }

        // ─── AUTO-TRIGGER: RA Renewal — update ra_renewal_date +1 year on completion ───
        if (delivery.service_type === "State RA Renewal" && isCompleted && delivery.account_id) {
          try {
            const { data: acct } = await supabaseAdmin
              .from("accounts")
              .select("ra_renewal_date")
              .eq("id", delivery.account_id)
              .single()

            if (acct?.ra_renewal_date) {
              const currentDate = new Date(acct.ra_renewal_date)
              currentDate.setFullYear(currentDate.getFullYear() + 1)
              const newDate = currentDate.toISOString().split("T")[0]

              await supabaseAdmin
                .from("accounts")
                .update({ ra_renewal_date: newDate, updated_at: new Date().toISOString() })
                .eq("id", delivery.account_id)

              lines.push(`\n🔄 RA renewal date updated: ${acct.ra_renewal_date} → ${newDate}`)
            }

            // Close related open tasks
            const { data: openTasks } = await supabaseAdmin
              .from("tasks")
              .select("id")
              .eq("delivery_id", delivery_id)
              .in("status", ["To Do", "In Progress"])

            if (openTasks?.length) {
              await supabaseAdmin
                .from("tasks")
                .update({ status: "Done", updated_at: new Date().toISOString() })
                .eq("delivery_id", delivery_id)
                .in("status", ["To Do", "In Progress"])

              lines.push(`✅ Closed ${openTasks.length} related task(s)`)
            }
          } catch (raErr) {
            lines.push(`\n⚠️ RA renewal auto-update failed: ${raErr instanceof Error ? raErr.message : String(raErr)}`)
          }
        }

        // ─── AUTO-TRIGGER: Annual Report — update annual_report_due_date +1 year on completion ───
        if (delivery.service_type === "State Annual Report" && isCompleted && delivery.account_id) {
          try {
            const { data: acct } = await supabaseAdmin
              .from("accounts")
              .select("annual_report_due_date")
              .eq("id", delivery.account_id)
              .single()

            if (acct?.annual_report_due_date) {
              const currentDate = new Date(acct.annual_report_due_date)
              currentDate.setFullYear(currentDate.getFullYear() + 1)
              const newDate = currentDate.toISOString().split("T")[0]

              await supabaseAdmin
                .from("accounts")
                .update({ annual_report_due_date: newDate, updated_at: new Date().toISOString() })
                .eq("id", delivery.account_id)

              lines.push(`\n📋 Annual report due date updated: ${acct.annual_report_due_date} → ${newDate}`)
            }

            // Close related open tasks
            const { data: arTasks } = await supabaseAdmin
              .from("tasks")
              .select("id")
              .eq("delivery_id", delivery_id)
              .in("status", ["To Do", "In Progress"])

            if (arTasks?.length) {
              await supabaseAdmin
                .from("tasks")
                .update({ status: "Done", updated_at: new Date().toISOString() })
                .eq("delivery_id", delivery_id)
                .in("status", ["To Do", "In Progress"])

              lines.push(`✅ Closed ${arTasks.length} related task(s)`)
            }
          } catch (arErr) {
            lines.push(`\n⚠️ Annual report auto-update failed: ${arErr instanceof Error ? arErr.message : String(arErr)}`)
          }
        }

        // ─── AUTO-TRIGGER: Set initial renewal dates on Company Formation closing stages ───
        if (
          delivery.service_type === "Company Formation" &&
          (targetStage.stage_name === "Post-Formation + Banking" || targetStage.stage_name === "Closing") &&
          delivery.account_id
        ) {
          try {
            const { data: acctDates } = await supabaseAdmin
              .from("accounts")
              .select("cmra_renewal_date, annual_report_due_date, state_of_formation, formation_date")
              .eq("id", delivery.account_id)
              .single()

            if (acctDates) {
              const renewals: Record<string, unknown> = {}
              const currentYear = new Date().getFullYear()

              // CMRA: Dec 31 current year (if not already set)
              if (!acctDates.cmra_renewal_date) {
                renewals.cmra_renewal_date = `${currentYear}-12-31`
              }

              // Annual Report: per state (if not already set)
              if (!acctDates.annual_report_due_date) {
                const st = (acctDates.state_of_formation || "").toUpperCase()
                  .replace("NEW MEXICO", "NM").replace("WYOMING", "WY")
                  .replace("FLORIDA", "FL").replace("DELAWARE", "DE")

                if (st === "FL") renewals.annual_report_due_date = `${currentYear + 1}-05-01`
                else if (st === "DE") renewals.annual_report_due_date = `${currentYear + 1}-06-01`
                else if (st === "WY" && acctDates.formation_date) {
                  const month = String(acctDates.formation_date).slice(5, 7)
                  renewals.annual_report_due_date = `${currentYear + 1}-${month}-01`
                }
                // NM: no annual report
              }

              if (Object.keys(renewals).length > 0) {
                renewals.updated_at = new Date().toISOString()
                await supabaseAdmin.from("accounts").update(renewals).eq("id", delivery.account_id)
                const datesList = Object.entries(renewals)
                  .filter(([k]) => k !== "updated_at")
                  .map(([k, v]) => `${k}=${v}`).join(", ")
                lines.push(`\n📅 Renewal dates set: ${datesList}`)
              }
            }
          } catch (rdErr) {
            lines.push(`\n⚠️ Renewal dates failed: ${rdErr instanceof Error ? rdErr.message : String(rdErr)}`)
          }
        }

        // ─── AUTO-TRIGGER: Welcome Package on "Post-Formation + Banking" ───
        if (
          delivery.service_type === "Company Formation" &&
          targetStage.stage_name === "Post-Formation + Banking" &&
          delivery.account_id
        ) {
          try {
            // Check if welcome package was already prepared
            const { data: acctCheck } = await supabaseAdmin
              .from("accounts")
              .select("welcome_package_status")
              .eq("id", delivery.account_id)
              .single()

            if (acctCheck?.welcome_package_status) {
              lines.push(`\n📦 Welcome package: already ${acctCheck.welcome_package_status}`)
            } else {
              // Enqueue welcome_package_prepare as a job
              const { enqueueJob } = await import("@/lib/jobs/queue")
              await enqueueJob({
                job_type: "welcome_package_prepare",
                payload: { account_id: delivery.account_id },
                priority: 5,
              })
              lines.push(`\n📦 Welcome package job enqueued — will prepare OA, Lease, banking forms, and email draft`)
            }
          } catch (wpErr) {
            lines.push(`\n⚠️ Welcome package auto-trigger failed: ${wpErr instanceof Error ? wpErr.message : String(wpErr)}`)
          }
        }

        // ─── AUTO-TRIGGER: Company Closure Stage 5 — Cancel all active services ───
        if (
          delivery.service_type === "Company Closure" &&
          targetStage.stage_name === "Closing" &&
          delivery.account_id
        ) {
          try {
            const closureLines: string[] = []

            // Cancel all active SDs for this account (except this closure SD)
            const { data: activeSds } = await supabaseAdmin
              .from("service_deliveries")
              .select("id, service_type")
              .eq("account_id", delivery.account_id)
              .eq("status", "active")
              .neq("id", delivery_id)

            if (activeSds?.length) {
              for (const sd of activeSds) {
                await supabaseAdmin
                  .from("service_deliveries")
                  .update({ status: "cancelled", updated_at: new Date().toISOString() })
                  .eq("id", sd.id)
              }
              closureLines.push(`Cancelled ${activeSds.length} active SDs: ${activeSds.map(s => s.service_type).join(", ")}`)
            }

            // Set account to Inactive
            await supabaseAdmin
              .from("accounts")
              .update({ status: "Inactive", updated_at: new Date().toISOString() })
              .eq("id", delivery.account_id)
            closureLines.push("Account -> Inactive")

            // Deactivate portal
            await supabaseAdmin
              .from("accounts")
              .update({ portal_account: false, updated_at: new Date().toISOString() })
              .eq("id", delivery.account_id)
            closureLines.push("Portal deactivated")

            // Close all open tasks for this account
            const { data: openTasks } = await supabaseAdmin
              .from("tasks")
              .select("id")
              .eq("account_id", delivery.account_id)
              .in("status", ["To Do", "In Progress", "Waiting"])

            if (openTasks?.length) {
              await supabaseAdmin
                .from("tasks")
                .update({ status: "Done", updated_at: new Date().toISOString() })
                .eq("account_id", delivery.account_id)
                .in("status", ["To Do", "In Progress", "Waiting"])
              closureLines.push(`Closed ${openTasks.length} open tasks`)
            }

            // Create tasks for manual steps
            await supabaseAdmin.from("tasks").insert([
              {
                task_title: `[CLOSURE] Remove RA on Harbor Compliance`,
                description: `Company closure in progress. Remove Registered Agent service from Harbor Compliance portal.`,
                assigned_to: "Luca", priority: "High", category: "Filing", status: "To Do",
                account_id: delivery.account_id, delivery_id, created_by: "System",
              },
              {
                task_title: `[CLOSURE] Cancel QB recurring invoices`,
                description: `Company closure. Check QuickBooks for any recurring invoices and cancel them.`,
                assigned_to: "Luca", priority: "Normal", category: "Payment", status: "To Do",
                account_id: delivery.account_id, delivery_id, created_by: "System",
              },
              {
                task_title: `[CLOSURE] Email client -- closure complete`,
                description: `All closure steps done. Send confirmation email to client that their LLC has been dissolved.`,
                assigned_to: "Luca", priority: "Normal", category: "Client Communication", status: "To Do",
                account_id: delivery.account_id, delivery_id, created_by: "System",
              },
            ])
            closureLines.push("Created 3 tasks: Harbor RA, QB invoices, client email")

            if (closureLines.length > 0) {
              lines.push("")
              lines.push("CLOSURE AUTO-CLEANUP:")
              closureLines.forEach(l => lines.push(`   ${l}`))
            }
          } catch (closureErr) {
            lines.push(`\n Warning: Closure auto-cleanup failed: ${closureErr instanceof Error ? closureErr.message : String(closureErr)}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // sd_create
  // ═══════════════════════════════════════
  server.tool(
    "sd_create",
    "Create a new service delivery and initialize it at the first pipeline stage. Auto-creates tasks for the first stage. Use this when starting a new service for a client (LLC Formation, Tax Return, etc.). Returns the created delivery with ID.",
    {
      service_type: z.string().describe("Service type: 'Company Formation', 'Tax Return', 'EIN', 'ITIN', 'Banking Fintech', 'Annual Renewal', 'CMRA Mailing Address'"),
      account_id: z.string().uuid().optional().describe("CRM account UUID. Required for LLC services. Omit for individual clients (ITIN, Banking Physical) — use contact_id instead."),
      contact_id: z.string().uuid().optional().describe("Primary contact UUID. Required for individual clients when account_id is omitted."),
      deal_id: z.string().uuid().optional().describe("Linked deal UUID"),
      service_name: z.string().optional().describe("Custom name (defaults to service_type + company name)"),
      assigned_to: z.string().optional().default("Luca").describe("Assignee (default: Luca)"),
      amount: z.number().optional().describe("Service amount"),
      amount_currency: z.string().optional().default("USD").describe("Currency (default: USD)"),
      notes: z.string().optional(),
    },
    async ({ service_type, account_id, contact_id, deal_id, service_name, assigned_to, amount, amount_currency, notes }) => {
      try {
        if (!account_id && !contact_id) {
          return { content: [{ type: "text" as const, text: "❌ Either account_id or contact_id is required. Use account_id for LLC services, contact_id for individual clients." }] }
        }

        // Get name for service_name default
        let clientName = "Unknown"
        if (account_id) {
          const { data: account } = await supabaseAdmin
            .from("accounts")
            .select("company_name")
            .eq("id", account_id)
            .single()
          clientName = account?.company_name || "Unknown"
        } else if (contact_id) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name")
            .eq("id", contact_id)
            .single()
          clientName = contact?.full_name || "Unknown"
        }

        const name = service_name || `${service_type} — ${clientName}`

        // Idempotency: check if an active delivery already exists for same type + account/contact
        const idempotencyQuery = supabaseAdmin
          .from("service_deliveries")
          .select("id, service_name, stage, status")
          .eq("service_type", service_type)
          .eq("status", "active")
          .limit(1)

        if (account_id) idempotencyQuery.eq("account_id", account_id)
        else idempotencyQuery.is("account_id", null).eq("contact_id", contact_id!)

        const { data: existingSD } = await idempotencyQuery

        if (existingSD?.length) {
          return { content: [{ type: "text" as const, text: `⚠️ Active "${service_type}" delivery already exists for this account:\n  ID: ${existingSD[0].id}\n  Name: ${existingSD[0].service_name}\n  Stage: ${existingSD[0].stage}\n\nUse sd_advance_stage to progress it, or complete/cancel it before creating a new one.` }] }
        }

        // Get first pipeline stage
        const { data: firstStage } = await supabaseAdmin
          .from("pipeline_stages")
          .select("*")
          .eq("service_type", service_type)
          .order("stage_order")
          .limit(1)
          .single()

        // Create delivery
        const { data: delivery, error: cErr } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_name: name,
            service_type,
            pipeline: service_type,
            stage: firstStage?.stage_name || null,
            stage_order: firstStage?.stage_order || null,
            stage_entered_at: new Date().toISOString(),
            stage_history: firstStage ? [{ to_stage: firstStage.stage_name, to_order: firstStage.stage_order, advanced_at: new Date().toISOString(), notes: "Created" }] : [],
            account_id: account_id || null,
            contact_id: contact_id || null,
            deal_id: deal_id || null,
            status: "active",
            start_date: new Date().toISOString().split("T")[0],
            assigned_to: assigned_to || "Luca",
            amount: amount || null,
            amount_currency: amount_currency || "USD",
            current_step: 1,
            total_steps: firstStage ? undefined : undefined,
            notes: notes || null,
          })
          .select()
          .single()
        if (cErr) throw new Error(cErr.message)

        // Auto-create tasks for first stage
        const createdTasks: string[] = []
        if (firstStage?.auto_tasks && Array.isArray(firstStage.auto_tasks)) {
          for (const taskDef of firstStage.auto_tasks as Array<{ title: string; assigned_to: string; category: string; priority: string }>) {
            await supabaseAdmin.from("tasks").insert({
              task_title: `[${name}] ${taskDef.title}`,
              assigned_to: taskDef.assigned_to || "Luca",
              category: taskDef.category || "Internal",
              priority: taskDef.priority || "Normal",
              description: `Auto-created on service delivery creation`,
              status: "To Do",
              account_id,
              deal_id: deal_id || null,
              delivery_id: delivery?.id,
              stage_order: firstStage?.stage_order || null,
            })
            createdTasks.push(taskDef.title)
          }
        }

        logAction({
          action_type: "create",
          table_name: "service_deliveries",
          record_id: delivery?.id,
          account_id: account_id,
          summary: `Service delivery created: ${name} (${service_type})`,
          details: { service_type, service_name: name, assigned_to, first_stage: firstStage?.stage_name, tasks_created: createdTasks },
        })

        const lines = [
          `✅ Service delivery created`,
          `📋 ${name}`,
          `🆔 ${delivery?.id}`,
          `📊 Stage: ${firstStage?.stage_name || "No pipeline defined"}`,
        ]
        if (createdTasks.length > 0) {
          lines.push(`\n📝 Auto-created ${createdTasks.length} tasks:`)
          for (const t of createdTasks) lines.push(`  • ${t}`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // audit_crm — Quality audit of Claude.ai sessions
  // ═══════════════════════════════════════
  server.tool(
    "audit_crm",
    "Run a quality audit on recent Claude.ai activity. Cross-checks session_checkpoints, action_log, tasks, and service_deliveries to find: (1) tasks still open for completed actions, (2) service notes updated without task closure, (3) stage advances without task cleanup, (4) checkpoints without matching action_log entries. Returns a structured report with issues found. Run this 2-3x daily.",
    {
      hours_back: z.number().optional().default(8).describe("How many hours back to audit (default: 8)"),
    },
    async ({ hours_back }) => {
      try {
        const since = new Date(Date.now() - hours_back * 60 * 60 * 1000).toISOString()
        const issues: string[] = []
        const ok: string[] = []

        // 1. Get recent checkpoints
        const { data: checkpoints } = await supabaseAdmin
          .from("session_checkpoints")
          .select("*")
          .gte("created_at", since)
          .order("created_at", { ascending: false })

        // 2. Get recent action_log entries
        const { data: actions } = await supabaseAdmin
          .from("action_log")
          .select("*")
          .gte("created_at", since)
          .order("created_at", { ascending: false })

        // 3. Find tasks still open where related service was updated recently
        const { data: openTasksWithUpdatedServices } = await supabaseAdmin.rpc("exec_sql", {
          query: `
            SELECT t.id, t.task_title, t.status, t.account_id, a.company_name,
                   s.notes as service_notes, s.updated_at as service_updated
            FROM tasks t
            JOIN accounts a ON a.id = t.account_id
            JOIN services s ON s.account_id = t.account_id
            WHERE t.status IN ('To Do', 'In Progress', 'Waiting')
              AND s.updated_at >= '${since}'
              AND t.created_at < s.updated_at
              AND (
                t.category IN ('Filing', 'Formation', 'CRM Update', 'Document')
                OR t.task_title ILIKE '%verificare%'
                OR t.task_title ILIKE '%check%'
              )
            ORDER BY s.updated_at DESC
            LIMIT 20
          `
        })

        // 4. Find active deliveries with stage but open tasks from previous stages
        const { data: stageOrphans } = await supabaseAdmin.rpc("exec_sql", {
          query: `
            SELECT sd.id as delivery_id, sd.service_name, sd.stage, sd.stage_order,
                   t.id as task_id, t.task_title, t.status as task_status,
                   a.company_name
            FROM service_deliveries sd
            JOIN tasks t ON t.service_id = sd.id
            JOIN accounts a ON a.id = sd.account_id
            WHERE sd.status = 'active'
              AND sd.stage IS NOT NULL
              AND sd.stage_order > 1
              AND t.status IN ('To Do', 'In Progress', 'Waiting')
              AND t.task_title LIKE '[%'
              AND sd.updated_at >= '${since}'
            ORDER BY sd.updated_at DESC
            LIMIT 20
          `
        })

        // Build report
        const lines: string[] = [
          `📊 **CRM Audit Report** — last ${hours_back} hours`,
          `⏰ Since: ${new Date(since).toLocaleString("it-IT", { timeZone: "America/New_York" })}`,
          "",
          `📝 Checkpoints: ${checkpoints?.length || 0}`,
          `📋 Actions logged: ${actions?.length || 0}`,
          "",
        ]

        // Checkpoint analysis
        if (checkpoints?.length) {
          lines.push("### Session Activity")
          for (const cp of checkpoints.slice(0, 5)) {
            const time = new Date(cp.created_at).toLocaleString("it-IT", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })
            lines.push(`  ${time} — ${cp.summary.slice(0, 120)}`)
          }
          lines.push("")
        }

        // Issue: tasks open but service updated
        if (openTasksWithUpdatedServices?.length) {
          for (const row of openTasksWithUpdatedServices) {
            issues.push(`⚠️ **${row.company_name}**: Task "${row.task_title}" still ${row.task_status}, but service was updated ${new Date(row.service_updated).toLocaleString("it-IT", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })}`)
          }
        }

        // Issue: stage orphan tasks
        if (stageOrphans?.length) {
          for (const row of stageOrphans) {
            issues.push(`⚠️ **${row.company_name}**: Delivery at stage "${row.stage}" but task "${row.task_title}" still ${row.task_status}`)
          }
        }

        // Checkpoint without actions
        if ((checkpoints?.length || 0) > 0 && (actions?.length || 0) === 0) {
          issues.push(`❌ ${checkpoints!.length} checkpoints saved but 0 actions in action_log — Claude.ai may not be logging actions properly`)
        }

        // Format issues
        if (issues.length > 0) {
          lines.push(`### 🔺 Issues Found (${issues.length})`)
          for (const issue of issues) lines.push(issue)
        } else {
          lines.push("### ✅ No Issues Found")
          lines.push("All checkpoints, tasks, and service records are consistent.")
        }

        // Action log summary
        if (actions?.length) {
          lines.push("")
          lines.push("### Action Log Summary")
          const byType: Record<string, number> = {}
          for (const a of actions) { byType[a.action_type] = (byType[a.action_type] || 0) + 1 }
          for (const [type, count] of Object.entries(byType)) {
            lines.push(`  ${type}: ${count}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Audit error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // cron_status
  // ═══════════════════════════════════════
  server.tool(
    "cron_status",
    "Show recent Vercel cron executions — success/error, duration, last run time. Use this to check if crons (QB refresh, sync-drive, sync-airtable) are running correctly. Returns the last 5 executions per endpoint.",
    {},
    async () => {
      try {
        const { data, error } = await supabaseAdmin
          .from("cron_log")
          .select("*")
          .order("executed_at", { ascending: false })
          .limit(20)

        if (error) throw error

        const rows = data || []
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: "No cron executions logged yet. Crons run every 6h — check back later or verify CRON_SECRET is set on Vercel." }] }
        }

        // Group by endpoint
        const grouped: Record<string, typeof rows> = {}
        for (const row of rows) {
          if (!grouped[row.endpoint]) grouped[row.endpoint] = []
          if (grouped[row.endpoint].length < 5) grouped[row.endpoint].push(row)
        }

        const lines: string[] = ["# Cron Status\n"]
        for (const [endpoint, entries] of Object.entries(grouped)) {
          const lastRun = entries[0]
          const status = lastRun.status === "success" ? "✅" : "❌"
          lines.push(`## ${endpoint} ${status}`)
          lines.push(`Last run: ${new Date(lastRun.executed_at).toISOString()}`)
          if (lastRun.error_message) lines.push(`Error: ${lastRun.error_message}`)
          lines.push("")
          lines.push("| Time | Status | Duration |")
          lines.push("|------|--------|----------|")
          for (const e of entries) {
            const time = new Date(e.executed_at).toISOString().substring(0, 19).replace("T", " ")
            const dur = e.duration_ms ? `${e.duration_ms}ms` : "—"
            const s = e.status === "success" ? "✅" : `❌ ${e.error_message?.substring(0, 40) || ""}`
            lines.push(`| ${time} | ${s} | ${dur} |`)
          }
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] }
      }
    }
  )
}
