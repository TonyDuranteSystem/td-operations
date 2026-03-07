/**
 * CRM Tools — Supabase queries for accounts, contacts, payments, services, deals, tasks
 * These tools allow Claude to search and retrieve CRM data from any device.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerCrmTools(server: McpServer) {

  // ═══════════════════════════════════════
  // crm_search_accounts
  // ═══════════════════════════════════════
  server.tool(
    "crm_search_accounts",
    "Search client company accounts by name, state, status, or entity type. Returns account details including company name, EIN, state, formation date, services bundle, and client health.",
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
    "Search contacts by name, email, phone, or citizenship. Returns contact details including ITIN, passport status, language preference.",
    {
      query: z.string().optional().describe("Search text (matches name, email, or phone)"),
      citizenship: z.string().optional().describe("Citizenship filter"),
      has_itin: z.boolean().optional().describe("Filter for contacts with/without ITIN"),
      limit: z.number().optional().default(25).describe("Max results (default 25)"),
    },
    async ({ query, citizenship, has_itin, limit }) => {
      let q = supabaseAdmin
        .from('contacts')
        .select('*')
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
    "Search payments by status, account, currency, date range, or amount. Returns payment details with linked company name.",
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
    "Search services by type, status, or account. Returns service details including progress (current_step/total_steps), SLA dates, and blocking status.",
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
    "Search tasks by status, priority, assignee, or category. Returns task details with linked company name.",
    {
      status: z.string().optional().describe("Task status (e.g., todo, in_progress, done, blocked)"),
      priority: z.string().optional().describe("Priority (urgente, normale, bassa)"),
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
    "Search deals/opportunities by stage, type, or account. Returns deal pipeline data.",
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
    "Get a complete summary of a client: account details, contacts, services, payments, deals, and tasks. Use this for a full client overview.",
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
}
