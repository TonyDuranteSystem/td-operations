/**
 * CRM Tools — Supabase queries for accounts, contacts, payments, services, deals, tasks
 * These tools allow Claude to search and retrieve CRM data from any device.
 */

import { syncSupabaseToAirtable } from "@/lib/sync-airtable"
import { upsertCompany, upsertContact, associateContactToCompany } from "@/lib/hubspot"
import { logAction } from "@/lib/mcp/action-log"

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ─── Auto-advance pipeline when all stage tasks are Done ─────
async function checkAndAutoAdvance(taskId: string): Promise<string | null> {
  // 1. Get the completed task
  const { data: task } = await supabaseAdmin
    .from("tasks")
    .select("delivery_id, stage_order, status")
    .eq("id", taskId)
    .single()

  if (!task?.delivery_id || task.stage_order == null) return null
  if (task.status !== "Done") return null

  // 2. Get the service delivery — must be active and at the same stage
  const { data: delivery } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, service_name, service_type, stage, stage_order, stage_history, status, account_id, deal_id")
    .eq("id", task.delivery_id)
    .single()

  if (!delivery || delivery.status !== "active") return null
  if (delivery.stage_order !== task.stage_order) return null

  // 3. Check pipeline_stage config
  const { data: currentPipelineStage } = await supabaseAdmin
    .from("pipeline_stages")
    .select("auto_advance, requires_approval, stage_name")
    .eq("service_type", delivery.service_type)
    .eq("stage_order", delivery.stage_order)
    .single()

  if (!currentPipelineStage) return null
  if (currentPipelineStage.requires_approval) return null
  if (currentPipelineStage.auto_advance === false) return null

  // 4. Count incomplete sibling tasks for this stage
  const { count } = await supabaseAdmin
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("delivery_id", task.delivery_id)
    .eq("stage_order", task.stage_order)
    .not("status", "in", '("Done","Cancelled")')

  if ((count ?? 0) > 0) return null

  // 5. All tasks done — find next stage
  const { data: stages } = await supabaseAdmin
    .from("pipeline_stages")
    .select("*")
    .eq("service_type", delivery.service_type)
    .order("stage_order")

  if (!stages?.length) return null

  const nextStage = stages.find(s => s.stage_order > delivery.stage_order!)
  if (!nextStage) return null

  // 6. Advance delivery (with optimistic lock on stage_order)
  const historyEntry = {
    from_stage: delivery.stage,
    from_order: delivery.stage_order,
    to_stage: nextStage.stage_name,
    to_order: nextStage.stage_order,
    advanced_at: new Date().toISOString(),
    notes: "Auto-advanced: all stage tasks completed",
  }
  const stageHistory = Array.isArray(delivery.stage_history)
    ? [...delivery.stage_history, historyEntry]
    : [historyEntry]

  const isFinal = !stages.find(s => s.stage_order > nextStage.stage_order)

  const { error: advErr } = await supabaseAdmin
    .from("service_deliveries")
    .update({
      stage: nextStage.stage_name,
      stage_order: nextStage.stage_order,
      stage_entered_at: new Date().toISOString(),
      stage_history: stageHistory,
      status: isFinal ? "completed" : "active",
      ...(isFinal ? { end_date: new Date().toISOString().split("T")[0] } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", delivery.id)
    .eq("stage_order", delivery.stage_order) // optimistic lock

  if (advErr) return null

  // 7. Create auto-tasks for the new stage
  const createdTasks: string[] = []
  if (nextStage.auto_tasks && Array.isArray(nextStage.auto_tasks)) {
    for (const taskDef of nextStage.auto_tasks as Array<{ title: string; assigned_to?: string; category?: string; priority?: string; description?: string }>) {
      const { error: tErr } = await supabaseAdmin.from("tasks").insert({
        task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
        assigned_to: taskDef.assigned_to || "Luca",
        category: taskDef.category || "Internal",
        priority: taskDef.priority || "Normal",
        description: taskDef.description || `Auto-created by pipeline advance to "${nextStage.stage_name}"`,
        status: "To Do",
        account_id: delivery.account_id,
        deal_id: delivery.deal_id,
        delivery_id: delivery.id,
        stage_order: nextStage.stage_order,
      })
      if (!tErr) createdTasks.push(taskDef.title)
    }
  }

  logAction({
    action_type: "advance",
    table_name: "service_deliveries",
    record_id: delivery.id,
    account_id: delivery.account_id || undefined,
    summary: `Auto-advanced: ${delivery.stage} → ${nextStage.stage_name} (all tasks completed)`,
    details: { from_stage: delivery.stage, to_stage: nextStage.stage_name, tasks_created: createdTasks },
  })

  return `🔄 Auto-advanced "${delivery.service_name || delivery.service_type}": ${delivery.stage} → ${nextStage.stage_name}` +
    (createdTasks.length > 0 ? ` (created ${createdTasks.length} new tasks)` : "")
}

export function registerCrmTools(server: McpServer) {

  // ═══════════════════════════════════════
  // crm_search_accounts
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_accounts",
    "Search CRM accounts by name, status, state, or entity type. Use this to find client companies. Returns account ID, company name, EIN, status (Active/Inactive/Lead/Prospect), entity type (LLC/Corporation/Individual/Partnership), state, and client health. For full client details, use crm_get_client_summary after finding the account.",
    {
      query: z.string().optional().describe("Search text (matches company name, case-insensitive)"),
      state: z.string().optional().describe("State of formation (e.g., Wyoming, Delaware, Florida, New Mexico)"),
      status: z.string().optional().describe("Account status filter"),
      entity_type: z.string().optional().describe("Entity type (e.g., LLC, Corporation)"),
      client_health: z.string().optional().describe("Client health (green, yellow, red)"),
      limit: z.number().optional().default(25).describe("Max results (default 25, max 100)"),
    },
    async ({ query, state, status, entity_type, client_health, limit }) => {
      let q = supabaseAdmin
        .from('accounts')
        .select('*')
        .order('company_name')
        .limit(Math.min(limit || 25, 100))

      if (query) q = q.ilike('company_name', `%${query}%`)
      if (state) q = q.eq('state_of_formation', state)
      if (status) q = q.eq('status', status)
      if (entity_type) q = q.eq('entity_type', entity_type)
      if (client_health) q = q.eq('client_health', client_health)

      const { data, error, count } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching accounts: ${error.message}` }] }
      }

      const summary = `Found ${data?.length || 0} accounts${query ? ` matching "${query}"` : ''}${state ? ` in ${state}` : ''}`
      return {
        content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_search_contacts
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_contacts",
    "Search CRM contacts by name, email, or phone. Returns contact details AND their linked companies (via account_contacts junction). IMPORTANT: When a client messages you, ALWAYS search by their name here first — the result includes all their linked accounts with company_name and account_id, so you can immediately call crm_get_client_summary for each account. A person like 'Rodrigo' may own multiple LLCs with completely different names.",
    {
      query: z.string().optional().describe("Search text (matches name, email, or phone)"),
      citizenship: z.string().optional().describe("Citizenship filter"),
      has_itin: z.boolean().optional().describe("Filter for contacts with/without ITIN"),
      limit: z.number().optional().default(25).describe("Max results (default 25)"),
    },
    async ({ query, citizenship, has_itin, limit }) => {
      let q = supabaseAdmin
        .from('contacts')
        .select('*, account_contacts(account_id, role, accounts(id, company_name, status, entity_type, state_of_formation))')
        .order('full_name')
        .limit(Math.min(limit || 25, 100))

      if (query) {
        q = q.or(`full_name.ilike.%${query}%,email.ilike.%${query}%,phone.ilike.%${query}%`)
      }
      if (citizenship) q = q.eq('citizenship', citizenship)
      if (has_itin === true) q = q.not('itin_number', 'is', null)
      if (has_itin === false) q = q.is('itin_number', null)

      const { data, error } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching contacts: ${error.message}` }] }
      }

      return {
        content: [{ type: "text" as const, text: `Found ${data?.length || 0} contacts\n\n${JSON.stringify(data, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_search_payments
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_payments",
    "Search payment records by status, account, currency, date range, or amount. Returns payment ID, amount, date, type, status (paid/pending/overdue/cancelled), currency, and linked company name. Use this to check payment history or outstanding balances for a specific client.",
    {
      status: z.string().optional().describe("Payment status: paid, pending, overdue, cancelled, partial"),
      account_id: z.string().optional().describe("Filter by account UUID"),
      company_name: z.string().optional().describe("Filter by company name (partial match)"),
      currency: z.string().optional().describe("Currency: USD or EUR"),
      min_amount: z.number().optional().describe("Minimum payment amount"),
      max_amount: z.number().optional().describe("Maximum payment amount"),
      year: z.number().optional().describe("Payment year"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async ({ status, account_id, company_name, currency, min_amount, max_amount, year, limit }) => {
      let q = supabaseAdmin
        .from('payments')
        .select('*, accounts(company_name)')
        .order('due_date', { ascending: false })
        .limit(Math.min(limit || 50, 200))

      if (status) q = q.eq('status', status)
      if (account_id) q = q.eq('account_id', account_id)
      if (currency) q = q.eq('amount_currency', currency)
      if (min_amount) q = q.gte('amount', min_amount)
      if (max_amount) q = q.lte('amount', max_amount)
      if (year) q = q.eq('year', year)

      const { data, error } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching payments: ${error.message}` }] }
      }

      // If filtering by company name, filter in memory (join + ilike not supported this way)
      let results = data || []
      if (company_name) {
        const lower = company_name.toLowerCase()
        results = results.filter((p: Record<string, unknown>) => {
          const acct = p.accounts as { company_name?: string } | null
          return acct?.company_name?.toLowerCase().includes(lower)
        })
      }

      // Calculate totals
      const totalAmount = results.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0)
      const totalPaid = results.filter((p: Record<string, unknown>) => p.status === 'paid').reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0)
      const totalPending = totalAmount - totalPaid

      const summary = `Found ${results.length} payments | Total: $${totalAmount.toLocaleString()} | Paid: $${totalPaid.toLocaleString()} | Pending: $${totalPending.toLocaleString()}`

      return {
        content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(results, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_search_services
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_services",
    "Search service delivery records by type, status, or account. Returns service ID, type (LLC Formation/ITIN/EIN/Tax Return/Registered Agent), status, progress (current_step/total_steps), SLA dates, and blocking status. Use this to check active services or blocked deliveries.",
    {
      service_type: z.string().optional().describe("Service type (e.g., LLC Formation, ITIN, Registered Agent, Tax Return, EIN)"),
      status: z.string().optional().describe("Service status"),
      account_id: z.string().optional().describe("Filter by account UUID"),
      blocked: z.boolean().optional().describe("Filter blocked services only"),
      limit: z.number().optional().default(50),
    },
    async ({ service_type, status, account_id, blocked, limit }) => {
      let q = supabaseAdmin
        .from('services')
        .select('*, accounts(company_name)')
        .order('updated_at', { ascending: false })
        .limit(Math.min(limit || 50, 200))

      if (service_type) q = q.ilike('service_type', `%${service_type}%`)
      if (status) q = q.eq('status', status)
      if (account_id) q = q.eq('account_id', account_id)
      if (blocked === true) q = q.eq('blocked_waiting_external', true)

      const { data, error } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching services: ${error.message}` }] }
      }

      return {
        content: [{ type: "text" as const, text: `Found ${data?.length || 0} services\n\n${JSON.stringify(data, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_search_tasks
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_tasks",
    "Search tasks/tickets by status, priority, assignee, or category. Returns task ID, title, description, status (To Do/In Progress/Done/Waiting), priority (Urgent/High/Normal/Low), due date, assignee, and linked company name. Use this for task management and tracking work items.",
    {
      status: z.string().optional().describe("Task status (e.g., To Do, In Progress, Done, Waiting)"),
      priority: z.string().optional().describe("Priority (Urgent, High, Normal, Low)"),
      assigned_to: z.string().optional().describe("Assignee name"),
      category: z.string().optional().describe("Task category"),
      account_id: z.string().optional().describe("Filter by account UUID"),
      limit: z.number().optional().default(50),
    },
    async ({ status, priority, assigned_to, category, account_id, limit }) => {
      let q = supabaseAdmin
        .from('tasks')
        .select('*, accounts(company_name)')
        .order('due_date', { ascending: true })
        .limit(Math.min(limit || 50, 200))

      if (status) q = q.eq('status', status)
      if (priority) q = q.eq('priority', priority)
      if (assigned_to) q = q.ilike('assigned_to', `%${assigned_to}%`)
      if (category) q = q.eq('category', category)
      if (account_id) q = q.eq('account_id', account_id)

      const { data, error } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching tasks: ${error.message}` }] }
      }

      return {
        content: [{ type: "text" as const, text: `Found ${data?.length || 0} tasks\n\n${JSON.stringify(data, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_search_deals
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_deals",
    "Search deals/opportunities by stage, type, or account. Returns deal ID, name, stage, value, deal type, and linked company. Use this to check the sales pipeline or find deals for a specific client.",
    {
      stage: z.string().optional().describe("Deal stage"),
      deal_type: z.string().optional().describe("Deal type"),
      account_id: z.string().optional().describe("Filter by account UUID"),
      limit: z.number().optional().default(50),
    },
    async ({ stage, deal_type, account_id, limit }) => {
      let q = supabaseAdmin
        .from('deals')
        .select('*, accounts(company_name)')
        .order('updated_at', { ascending: false })
        .limit(Math.min(limit || 50, 100))

      if (stage) q = q.eq('stage', stage)
      if (deal_type) q = q.eq('deal_type', deal_type)
      if (account_id) q = q.eq('account_id', account_id)

      const { data, error } = await q

      if (error) {
        return { content: [{ type: "text" as const, text: `Error searching deals: ${error.message}` }] }
      }

      return {
        content: [{ type: "text" as const, text: `Found ${data?.length || 0} deals\n\n${JSON.stringify(data, null, 2)}` }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_get_client_summary
  // ═══════════════════════════════════════
  server.tool(
    "crm_get_client_summary",
    "Get a complete 360° view of a CRM account in one call: account details, contacts, services, payments, deals, tasks, and documents. Use this FIRST when asked about any specific client. Accepts account UUID or company name (fuzzy match). This is the primary tool for client-related questions — prefer it over individual search tools.",
    {
      account_id: z.string().optional().describe("Account UUID (use this if you have it)"),
      company_name: z.string().optional().describe("Company name search (use this if you don't have the ID)"),
    },
    async ({ account_id, company_name }) => {
      // Find the account
      let accountQuery = supabaseAdmin.from('accounts').select('*')
      if (account_id) {
        accountQuery = accountQuery.eq('id', account_id)
      } else if (company_name) {
        accountQuery = accountQuery.ilike('company_name', `%${company_name}%`)
      } else {
        return { content: [{ type: "text" as const, text: "Please provide either account_id or company_name" }] }
      }

      const { data: accounts, error: accErr } = await accountQuery
      if (accErr || !accounts?.length) {
        return { content: [{ type: "text" as const, text: accErr ? `Error: ${accErr.message}` : "Account not found" }] }
      }

      const account = accounts[0]
      const id = account.id

      // Fetch all related data in parallel
      const [contacts, services, payments, deals, tasks, documents] = await Promise.all([
        supabaseAdmin
          .from('account_contacts')
          .select('*, contacts(*)')
          .eq('account_id', id),
        supabaseAdmin
          .from('services')
          .select('*')
          .eq('account_id', id)
          .order('start_date', { ascending: false }),
        supabaseAdmin
          .from('payments')
          .select('*')
          .eq('account_id', id)
          .order('due_date', { ascending: false }),
        supabaseAdmin
          .from('deals')
          .select('*')
          .eq('account_id', id)
          .order('updated_at', { ascending: false }),
        supabaseAdmin
          .from('tasks')
          .select('*')
          .eq('account_id', id)
          .order('due_date', { ascending: true }),
        supabaseAdmin
          .from('documents')
          .select('id, file_name, document_type_name, category_name, confidence, status, processed_at')
          .eq('account_id', id)
          .order('category', { ascending: true }),
      ])

      // Calculate payment totals
      const paymentData = payments.data || []
      const totalInvoiced = paymentData.reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0)
      const totalPaid = paymentData
        .filter((p: Record<string, unknown>) => p.status === 'paid')
        .reduce((sum: number, p: Record<string, unknown>) => sum + ((p.amount as number) || 0), 0)
      const overduePayments = paymentData.filter((p: Record<string, unknown>) => p.status === 'overdue')

      const summary = {
        account: account,
        contacts: contacts.data?.map((ac: Record<string, unknown>) => ({
          ...(ac.contacts as Record<string, unknown>),
          role: ac.role,
        })) || [],
        services: {
          total: services.data?.length || 0,
          active: services.data?.filter((s: Record<string, unknown>) => s.status === 'active' || s.status === 'in_progress').length || 0,
          items: services.data || [],
        },
        payments: {
          total_invoiced: totalInvoiced,
          total_paid: totalPaid,
          balance_due: totalInvoiced - totalPaid,
          overdue_count: overduePayments.length,
          items: paymentData,
        },
        deals: deals.data || [],
        tasks: {
          total: tasks.data?.length || 0,
          open: tasks.data?.filter((t: Record<string, unknown>) => t.status !== 'done').length || 0,
          items: tasks.data || [],
        },
        documents: {
          total: documents.data?.length || 0,
          classified: documents.data?.filter((d: Record<string, unknown>) => d.status === 'classified').length || 0,
          unclassified: documents.data?.filter((d: Record<string, unknown>) => d.status === 'unclassified').length || 0,
          items: documents.data || [],
        },
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }]
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_dashboard_stats — Business snapshot in one call
  // ═══════════════════════════════════════
  server.tool(
    "crm_dashboard_stats",
    "Get CRM dashboard metrics for the entire business: account counts by status/type/state, service pipeline, payment totals (invoiced/paid/outstanding), document stats, deal pipeline, and task overview. Use this for reporting and overview questions. NOT for individual client queries — use crm_get_client_summary instead.",
    {},
    async () => {
      try {
        // Parallel queries for all major tables
        const [
          accountsRes,
          servicesRes,
          paymentsRes,
          documentsRes,
          tasksRes,
          dealsRes,
        ] = await Promise.all([
          supabaseAdmin.from("accounts").select("id, status, entity_type, state_of_formation, client_health"),
          supabaseAdmin.from("services").select("id, service_type, status, blocked_waiting_external"),
          supabaseAdmin.from("payments").select("id, status, amount, amount_currency, year"),
          supabaseAdmin
            .from("documents")
            .select("id, status, category_name, account_id"),
          supabaseAdmin.from("tasks").select("id, status, priority"),
          supabaseAdmin.from("deals").select("id, stage, value"),
        ])

        const accounts = accountsRes.data || []
        const services = servicesRes.data || []
        const payments = paymentsRes.data || []
        const documents = documentsRes.data || []
        const tasks = tasksRes.data || []
        const deals = dealsRes.data || []

        // ── Accounts ──
        const accByStatus: Record<string, number> = {}
        const accByType: Record<string, number> = {}
        const accByState: Record<string, number> = {}
        const accByHealth: Record<string, number> = {}
        let noEntityType = 0
        let noDriveFolder = 0

        for (const a of accounts) {
          accByStatus[a.status || "unknown"] = (accByStatus[a.status || "unknown"] || 0) + 1
          if (a.entity_type) {
            accByType[a.entity_type] = (accByType[a.entity_type] || 0) + 1
          } else {
            noEntityType++
          }
          if (a.state_of_formation) {
            accByState[a.state_of_formation] = (accByState[a.state_of_formation] || 0) + 1
          }
          if (a.client_health) {
            accByHealth[a.client_health] = (accByHealth[a.client_health] || 0) + 1
          }
        }

        // ── Services ──
        const svcByType: Record<string, number> = {}
        const svcByStatus: Record<string, number> = {}
        let blockedCount = 0
        for (const s of services) {
          svcByType[s.service_type || "unknown"] = (svcByType[s.service_type || "unknown"] || 0) + 1
          svcByStatus[s.status || "unknown"] = (svcByStatus[s.status || "unknown"] || 0) + 1
          if (s.blocked_waiting_external) blockedCount++
        }

        // ── Payments ──
        let totalInvoiced = 0
        let totalPaid = 0
        let totalOverdue = 0
        let totalPending = 0
        const payByStatus: Record<string, number> = {}
        const payByCurrency: Record<string, number> = {}

        for (const p of payments) {
          const amt = (p.amount as number) || 0
          totalInvoiced += amt
          payByStatus[p.status || "unknown"] = (payByStatus[p.status || "unknown"] || 0) + 1
          payByCurrency[p.amount_currency || "USD"] = (payByCurrency[p.amount_currency || "USD"] || 0) + amt

          if (p.status === "paid") totalPaid += amt
          else if (p.status === "overdue") totalOverdue += amt
          else if (p.status === "pending") totalPending += amt
        }

        // ── Documents ──
        const docByStatus: Record<string, number> = {}
        const docByCategory: Record<string, number> = {}
        const accountsWithDocs = new Set<string>()
        for (const d of documents) {
          docByStatus[d.status || "unknown"] = (docByStatus[d.status || "unknown"] || 0) + 1
          if (d.category_name) {
            docByCategory[d.category_name] = (docByCategory[d.category_name] || 0) + 1
          }
          if (d.account_id) accountsWithDocs.add(d.account_id)
        }

        // ── Tasks ──
        const taskByStatus: Record<string, number> = {}
        const taskByPriority: Record<string, number> = {}
        for (const t of tasks) {
          taskByStatus[t.status || "unknown"] = (taskByStatus[t.status || "unknown"] || 0) + 1
          if (t.priority) taskByPriority[t.priority] = (taskByPriority[t.priority] || 0) + 1
        }

        // ── Deals ──
        const dealByStage: Record<string, number> = {}
        let dealTotalValue = 0
        for (const d of deals) {
          dealByStage[d.stage || "unknown"] = (dealByStage[d.stage || "unknown"] || 0) + 1
          dealTotalValue += (d.value as number) || 0
        }

        // ── Build Output ──
        const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        const sortDesc = (obj: Record<string, number>) => Object.entries(obj).sort((a, b) => b[1] - a[1])

        const lines = [
          "📊 CRM Dashboard — Business Snapshot",
          "",
          `══ 🏢 Accounts (${accounts.length}) ══`,
          `By status: ${sortDesc(accByStatus).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          `By entity: ${sortDesc(accByType).map(([k, v]) => `${k}: ${v}`).join(" | ")}${noEntityType > 0 ? ` | ⚠️ No type: ${noEntityType}` : ""}`,
          `Top states: ${sortDesc(accByState).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          Object.keys(accByHealth).length > 0 ? `Health: 🟢${accByHealth["green"] || 0} 🟡${accByHealth["yellow"] || 0} 🔴${accByHealth["red"] || 0}` : "",
          "",
          `══ ⚙️ Services (${services.length}) ══`,
          `By type: ${sortDesc(svcByType).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          `By status: ${sortDesc(svcByStatus).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          blockedCount > 0 ? `🚧 Blocked (waiting external): ${blockedCount}` : "",
          "",
          `══ 💰 Payments (${payments.length}) ══`,
          `Total invoiced: ${fmt(totalInvoiced)}`,
          `Paid: ${fmt(totalPaid)} | Outstanding: ${fmt(totalInvoiced - totalPaid)}`,
          `Overdue: ${fmt(totalOverdue)} | Pending: ${fmt(totalPending)}`,
          `By status: ${sortDesc(payByStatus).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          Object.keys(payByCurrency).length > 1 ? `By currency: ${sortDesc(payByCurrency).map(([k, v]) => `${k}: ${fmt(v)}`).join(" | ")}` : "",
          "",
          `══ 📄 Documents (${documents.length}) ══`,
          `By status: ${sortDesc(docByStatus).map(([k, v]) => `${k}: ${v}`).join(" | ")}`,
          `Accounts with docs: ${accountsWithDocs.size}/${accounts.length}`,
          Object.keys(docByCategory).length > 0 ? `By category: ${sortDesc(docByCategory).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(" | ")}` : "",
          "",
          `══ ✅ Tasks (${tasks.length}) ══`,
          tasks.length > 0 ? `By status: ${sortDesc(taskByStatus).map(([k, v]) => `${k}: ${v}`).join(" | ")}` : "No tasks recorded",
          Object.keys(taskByPriority).length > 0 ? `By priority: ${sortDesc(taskByPriority).map(([k, v]) => `${k}: ${v}`).join(" | ")}` : "",
          "",
          `══ 🤝 Deals (${deals.length}) ══`,
          deals.length > 0
            ? `Pipeline value: ${fmt(dealTotalValue)} | By stage: ${sortDesc(dealByStage).map(([k, v]) => `${k}: ${v}`).join(" | ")}`
            : "No deals recorded",
        ]

        return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Dashboard stats failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ═══════════════════════════════════════
  // crm_update_record — Update any CRM record by UUID
  // ═══════════════════════════════════════
  server.tool(
    "crm_update_record",
    "Update any CRM record (account, contact, service, payment, task, deal) by UUID. Provide the table name, record ID, and fields to update. Only specified fields are changed — all others remain untouched. Returns the updated record. Use crm_search_* or crm_get_client_summary FIRST to find the record ID.",
    {
      table: z.enum(["accounts", "contacts", "services", "payments", "tasks", "deals", "leads", "deadlines", "tax_returns", "conversations", "service_deliveries"]).describe("CRM table to update"),
      id: z.string().uuid().describe("Record UUID to update (from crm_search_* or crm_get_client_summary)"),
      updates: z.record(z.string(), z.any()).describe("Fields to update as key-value pairs (e.g. {status: 'Active', phone: '+1234567890'})"),
    },
    async ({ table, id, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from(table)
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select("*")
          .single()

        if (error) throw error

        // Audit trail (fire-and-forget)
        logAction({
          action_type: "update",
          table_name: table,
          record_id: id,
          account_id: table === "accounts" ? id : (data.account_id || null),
          summary: `Updated ${table}: ${Object.keys(updates).join(", ")}`,
          details: { fields_changed: Object.keys(updates), new_values: updates },
        })

        // Post-update hook: auto-advance pipeline when task marked Done
        let autoAdvanceMsg = ""
        if (table === "tasks" && updates.status === "Done") {
          try {
            const msg = await checkAndAutoAdvance(id)
            if (msg) autoAdvanceMsg = `\n\n${msg}`
          } catch {
            // Non-blocking: don't fail the update if auto-advance errors
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `✅ ${table} record updated: ${id}\n${JSON.stringify(data, null, 2)}${autoAdvanceMsg}`,
          }],
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `❌ crm_update_record error: ${err.message}` }] }
      }
    }
  )

  // ─── crm_sync_hubspot ───────────────────────────────────────────────
  server.tool(
    "crm_sync_hubspot",
    "Sync CRM data from Supabase to HubSpot (one-way push). Syncs Active accounts as Companies, their contacts as Contacts, and creates associations. Requires HUBSPOT_PAT env var. Use dry_run to preview. Supports syncing specific accounts by ID or all Active accounts.",
    {
      dry_run: z.boolean().optional().default(false).describe("If true, preview what would sync without writing to HubSpot"),
      account_ids: z.array(z.string()).optional().describe("Specific account UUIDs to sync. If omitted, syncs all Active accounts."),
      limit: z.number().optional().default(0).describe("Max accounts to sync (0 = all)"),
    },
    async ({ dry_run, account_ids, limit }) => {
      try {
        // 1) Fetch accounts from Supabase
        let query = supabaseAdmin
          .from("accounts")
          .select("id, company_name, entity_type, ein_number, state_of_formation, formation_date, physical_address, status")
          .eq("status", "Active")
          .order("company_name")

        if (account_ids?.length) {
          query = query.in("id", account_ids)
        }
        if (limit && limit > 0) {
          query = query.limit(limit)
        }

        const { data: accounts, error: aErr } = await query
        if (aErr) throw aErr
        if (!accounts || accounts.length === 0) {
          return { content: [{ type: "text" as const, text: "No active accounts to sync." }] }
        }

        if (dry_run) {
          return {
            content: [{ type: "text" as const, text: `🔍 DRY RUN — ${accounts.length} accounts would sync:\n${accounts.map(a => `  • ${a.company_name}`).join("\n")}` }],
          }
        }

        let companiesSynced = 0, companiesFailed = 0
        let contactsSynced = 0, contactsFailed = 0
        let associationsCreated = 0
        const errors: string[] = []

        // Process sequentially — HubSpot has 4 API calls/second rate limit
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

        for (const account of accounts) {
          try {
            const companyId = await upsertCompany(account)
            companiesSynced++
            await delay(350)

            const { data: junctions } = await supabaseAdmin
              .from("account_contacts")
              .select("contact:contacts(id, full_name, first_name, last_name, email, email_2, phone, citizenship, itin_number, language)")
              .eq("account_id", account.id)

            if (!junctions) continue

            for (const j of junctions) {
              const contact = j.contact as unknown as {
                id: string; full_name: string; first_name: string | null; last_name: string | null
                email: string | null; email_2: string | null; phone: string | null
                citizenship: string | null; itin_number: string | null; language: string | null
              }
              if (!contact?.email) continue

              try {
                const contactId = await upsertContact(contact)
                if (contactId) {
                  contactsSynced++
                  await delay(350)
                  try {
                    await associateContactToCompany(contactId, companyId)
                    associationsCreated++
                    await delay(200)
                  } catch { /* non-fatal */ }
                }
              } catch (cErr) {
                contactsFailed++
                errors.push(`Contact ${contact.full_name}: ${cErr instanceof Error ? cErr.message : String(cErr)}`)
              }
            }
          } catch (err) {
            companiesFailed++
            errors.push(`Company ${account.company_name}: ${err instanceof Error ? err.message : String(err)}`)
            await delay(1000)
          }
        }

        const lines = [
          "✅ HubSpot sync complete",
          "",
          `📊 Companies: ${companiesSynced} synced, ${companiesFailed} failed`,
          `👤 Contacts: ${contactsSynced} synced, ${contactsFailed} failed`,
          `🔗 Associations: ${associationsCreated} created`,
        ]

        if (errors.length > 0) {
          lines.push("", `⚠️ Errors (${errors.length}):`, ...errors.slice(0, 20).map(e => `  • ${e}`))
          if (errors.length > 20) lines.push(`  ... and ${errors.length - 20} more`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ HubSpot sync failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )

  // ─── crm_sync_airtable ───────────────────────────────────────────────
  server.tool(
    "crm_sync_airtable",
    "Sync CRM data from Supabase to Airtable (one-way push). Updates accounts that have an airtable_id link. Use this when Airtable needs to reflect latest CRM changes. Supports dry_run mode to preview without writing.",
    {
      dry_run: z.boolean().optional().default(false).describe("If true, count records without actually updating Airtable"),
      limit: z.number().optional().default(0).describe("Max accounts to sync (0 = all)"),
    },
    async ({ dry_run, limit }) => {
      try {
        const stats = await syncSupabaseToAirtable({ dry_run, limit })

        const lines = [
          dry_run ? "🔍 DRY RUN — no changes made" : "✅ Sync complete",
          "",
          `📊 Total accounts with airtable_id: ${stats.total}`,
          `✅ Synced: ${stats.synced}`,
          `⏭️ Skipped (no data to push): ${stats.skipped}`,
          `❌ Failed: ${stats.failed}`,
          `⏱️ Elapsed: ${(stats.elapsed_ms / 1000).toFixed(1)}s`,
        ]

        if (stats.errors.length > 0) {
          lines.push("", "Errors:", ...stats.errors.map((e) => `  • ${e}`))
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `❌ Sync failed: ${error instanceof Error ? error.message : String(error)}` }],
        }
      }
    }
  )
}
