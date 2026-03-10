/**
 * Operations Tools — Task tracker, conversations, SOPs, service deliveries.
 * Visual dashboards for daily operations management.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

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
      service_id: z.string().uuid().optional().describe("Link to service UUID"),
      status: z.string().optional().describe("Initial status: To Do (default), In Progress, Waiting"),
    },
    async ({ task_title, assigned_to, priority, category, due_date, description, account_id, deal_id, service_id, status }) => {
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
          status: status || "To Do",
          created_by: "Claude",
        }

        const { data, error } = await supabaseAdmin
          .from("tasks")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        return { content: [{ type: "text" as const, text: `✅ Task created: ${data.task_title}\nAssigned: ${data.assigned_to} | Priority: ${data.priority} | Due: ${data.due_date || "—"}\nID: ${data.id}` }] }
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
    "Create a new CRM account (company/LLC). Use this when onboarding a new client after lead conversion. Returns the created account with ID.",
    {
      company_name: z.string().describe("Company/LLC name"),
      entity_type: z.string().optional().describe("Entity type (e.g., Single Member LLC, Multi-Member LLC, Corporation)"),
      state_of_formation: z.string().optional().describe("State of formation (e.g., Wyoming, Delaware, Florida)"),
      status: z.string().optional().describe("Account status (default: Active)"),
      ein: z.string().optional().describe("EIN number"),
      formation_date: z.string().optional().describe("Formation date (YYYY-MM-DD)"),
      notes: z.string().optional().describe("Account notes"),
    },
    async ({ company_name, entity_type, state_of_formation, status, ein, formation_date, notes }) => {
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

        const insert: Record<string, unknown> = {
          company_name,
          entity_type: entity_type || null,
          state_of_formation: state_of_formation || null,
          status: status || "Active",
          ein: ein || null,
          formation_date: formation_date || null,
          notes: notes || null,
        }

        const { data, error } = await supabaseAdmin
          .from("accounts")
          .insert(insert)
          .select("*")
          .single()

        if (error) throw new Error(error.message)

        return { content: [{ type: "text" as const, text: `✅ Account created: ${data.company_name}\nStatus: ${data.status} | State: ${data.state_of_formation || "—"}\nID: ${data.id}` }] }
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
      direction: z.string().optional().describe("Direction: inbound or outbound"),
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
      pipeline: z.string().optional().describe("Pipeline filter"),
      assigned_to: z.string().optional().describe("Assignee name"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ service_type, stage, status, account_id, pipeline, assigned_to, limit }) => {
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
}
