import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/ai-agent
 * CRM AI Agent — GPT-4o with function calling.
 * Can search accounts, services, payments, tasks, deadlines, tax returns.
 * Can create tasks and update records. Streams response.
 */

// ─── Tool definitions for OpenAI function calling ───

const TOOLS: Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}> = [
  {
    type: 'function',
    function: {
      name: 'search_accounts',
      description: 'Search CRM accounts by company name, status, state, or entity type. Returns matching accounts with key details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Company name search term (partial match)' },
          status: { type: 'string', description: 'Filter by status: Active, Pending, Inactive, Dormant, Dissolved' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_detail',
      description: 'Get full details for a specific account including contacts, services, payments, deadlines, and deals.',
      parameters: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'UUID of the account' },
        },
        required: ['account_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Search contacts by name or email.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or email search term' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_services',
      description: 'Search services by status, type, or account. Shows what work is in progress.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter: Not Started, In Progress, Waiting Client, Waiting Third Party, Completed, Cancelled' },
          service_type: { type: 'string', description: 'Filter by type: Formation, Tax, Compliance, Consulting, etc.' },
          account_id: { type: 'string', description: 'Filter by account UUID' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_payments',
      description: 'Search payments by status, account, or date range. Shows outstanding and completed payments.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter: Pending, Paid, Overdue, Partial, Cancelled' },
          account_id: { type: 'string', description: 'Filter by account UUID' },
          overdue_only: { type: 'boolean', description: 'Only show overdue payments' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search CRM tasks by status, priority, assignee, or keyword.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter: To Do, In Progress, Waiting, Done' },
          priority: { type: 'string', description: 'Filter: low, medium, high, urgent' },
          assigned_to: { type: 'string', description: 'Filter by assignee name' },
          query: { type: 'string', description: 'Search in task title' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tax_returns',
      description: 'Search tax returns by company, year, status, or type.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'Company name (partial match)' },
          tax_year: { type: 'number', description: 'Tax year (e.g. 2025)' },
          status: { type: 'string', description: 'Filter: Pending, In Progress, Filed, Extended' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_deadlines',
      description: 'Search upcoming or overdue deadlines.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter: Pending, Overdue, Completed' },
          account_id: { type: 'string', description: 'Filter by account UUID' },
          days_ahead: { type: 'number', description: 'Show deadlines within N days from today (default 30)' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new CRM task. Use this when the admin asks to create a task, reminder, or to-do.',
      parameters: {
        type: 'object',
        properties: {
          task_title: { type: 'string', description: 'Title of the task' },
          description: { type: 'string', description: 'Detailed description' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority level' },
          assigned_to: { type: 'string', description: 'Assignee name (e.g. Antonio, Luca)' },
          due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
          account_id: { type: 'string', description: 'Related account UUID (optional)' },
          company_name: { type: 'string', description: 'Related company name (optional)' },
          category: { type: 'string', description: 'Category: Tax, Formation, Compliance, Admin, Billing, Client Communication' },
        },
        required: ['task_title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_dashboard_stats',
      description: 'Get overview dashboard stats: total accounts by status, pending payments amount, open tasks count, upcoming deadlines.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql_query',
      description: 'Run a read-only SQL query against the CRM database for complex questions that other tools cannot answer. Use SELECT only — no INSERT, UPDATE, DELETE. Available tables: accounts, contacts, account_contacts, services, payments, tasks, deals, tax_returns, deadlines, leads, portal_messages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SELECT SQL query' },
        },
        required: ['query'],
      },
    },
  },
]

// ─── Tool execution ───

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'search_accounts': {
        let query = supabaseAdmin
          .from('accounts')
          .select('id, company_name, entity_type, status, state_of_formation, ein_number, formation_date, client_health')
        if (args.query) query = query.ilike('company_name', `%${args.query}%`)
        if (args.status) query = query.eq('status', args.status)
        const { data, error } = await query.order('company_name').limit(Number(args.limit) || 10)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify(data ?? [])
      }

      case 'get_account_detail': {
        const accountId = args.account_id as string
        const [account, contacts, services, payments, deadlines, deals] = await Promise.all([
          supabaseAdmin.from('accounts').select('*').eq('id', accountId).single(),
          supabaseAdmin.from('account_contacts').select('role, contact:contacts(id, full_name, email, phone, language)').eq('account_id', accountId),
          supabaseAdmin.from('services').select('id, service_name, service_type, status, current_step, total_steps, amount, amount_currency, sla_due_date, notes, updated_at').eq('account_id', accountId).order('updated_at', { ascending: false }),
          supabaseAdmin.from('payments').select('id, description, amount, amount_currency, status, due_date, paid_date, invoice_number, notes').eq('account_id', accountId).order('due_date', { ascending: false }).limit(20),
          supabaseAdmin.from('deadlines').select('id, deadline_type, due_date, status, notes').eq('account_id', accountId).order('due_date').limit(10),
          supabaseAdmin.from('deals').select('id, deal_name, stage, amount, deal_type, notes, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(10),
        ])
        return JSON.stringify({
          account: account.data,
          contacts: (contacts.data ?? []).map((c: Record<string, unknown>) => ({ ...c.contact as object, role: c.role })),
          services: services.data ?? [],
          payments: payments.data ?? [],
          deadlines: deadlines.data ?? [],
          deals: deals.data ?? [],
        })
      }

      case 'search_contacts': {
        const pattern = `%${args.query}%`
        const { data, error } = await supabaseAdmin
          .from('contacts')
          .select('id, full_name, email, phone, language, citizenship')
          .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
          .limit(10)
        if (error) return JSON.stringify({ error: error.message })
        // Also get their account associations
        const contactIds = (data ?? []).map(c => c.id)
        const { data: links } = contactIds.length
          ? await supabaseAdmin.from('account_contacts').select('contact_id, role, account:accounts(id, company_name)').in('contact_id', contactIds)
          : { data: [] }
        const linkMap = new Map<string, Array<{ company_name: string; role: string; account_id: string }>>()
        for (const l of links ?? []) {
          const acct = l.account as unknown as { id: string; company_name: string }
          if (!linkMap.has(l.contact_id)) linkMap.set(l.contact_id, [])
          linkMap.get(l.contact_id)!.push({ company_name: acct?.company_name, role: l.role, account_id: acct?.id })
        }
        return JSON.stringify((data ?? []).map(c => ({ ...c, accounts: linkMap.get(c.id) ?? [] })))
      }

      case 'search_services': {
        let query = supabaseAdmin
          .from('services')
          .select('id, service_name, service_type, status, current_step, total_steps, amount, amount_currency, sla_due_date, account_id, accounts!inner(company_name)')
        if (args.status) query = query.eq('status', args.status)
        if (args.service_type) query = query.eq('service_type', args.service_type)
        if (args.account_id) query = query.eq('account_id', args.account_id)
        const { data, error } = await query.order('updated_at', { ascending: false }).limit(Number(args.limit) || 20)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify((data ?? []).map(s => {
          const acct = s.accounts as unknown as { company_name: string }
          return { ...s, company_name: acct?.company_name, accounts: undefined }
        }))
      }

      case 'search_payments': {
        const today = new Date().toISOString().split('T')[0]
        let query = supabaseAdmin
          .from('payments')
          .select('id, description, amount, amount_currency, status, due_date, paid_date, invoice_number, account_id, accounts!inner(company_name)')
        if (args.status) query = query.eq('status', args.status)
        if (args.account_id) query = query.eq('account_id', args.account_id)
        if (args.overdue_only) query = query.eq('status', 'Pending').lt('due_date', today)
        const { data, error } = await query.order('due_date', { ascending: false }).limit(Number(args.limit) || 20)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify((data ?? []).map(p => {
          const acct = p.accounts as unknown as { company_name: string }
          return { ...p, company_name: acct?.company_name, accounts: undefined }
        }))
      }

      case 'search_tasks': {
        let query = supabaseAdmin
          .from('tasks')
          .select('id, task_title, status, priority, due_date, assigned_to, category, company_name, description')
        if (args.status) query = query.eq('status', args.status)
        if (args.priority) query = query.eq('priority', args.priority)
        if (args.assigned_to) query = query.ilike('assigned_to', `%${args.assigned_to}%`)
        if (args.query) query = query.ilike('task_title', `%${args.query}%`)
        const { data, error } = await query.order('due_date', { ascending: true }).limit(Number(args.limit) || 20)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify(data ?? [])
      }

      case 'search_tax_returns': {
        let query = supabaseAdmin
          .from('tax_returns')
          .select('id, company_name, client_name, return_type, tax_year, deadline, status, paid, data_received, extension_filed, extension_deadline, notes, updated_at')
        if (args.company_name) query = query.ilike('company_name', `%${args.company_name}%`)
        if (args.tax_year) query = query.eq('tax_year', args.tax_year)
        if (args.status) query = query.eq('status', args.status)
        const { data, error } = await query.order('tax_year', { ascending: false }).limit(Number(args.limit) || 20)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify(data ?? [])
      }

      case 'search_deadlines': {
        const today = new Date()
        const daysAhead = Number(args.days_ahead) || 30
        const futureDate = new Date(today)
        futureDate.setDate(futureDate.getDate() + daysAhead)

        let query = supabaseAdmin
          .from('deadlines')
          .select('id, deadline_type, due_date, status, notes, account_id, accounts!inner(company_name)')
        if (args.status) query = query.eq('status', args.status)
        if (args.account_id) query = query.eq('account_id', args.account_id)
        if (!args.status) query = query.in('status', ['Pending', 'Overdue'])
        query = query.lte('due_date', futureDate.toISOString().split('T')[0])
        const { data, error } = await query.order('due_date').limit(Number(args.limit) || 20)
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify((data ?? []).map(d => {
          const acct = d.accounts as unknown as { company_name: string }
          return { ...d, company_name: acct?.company_name, accounts: undefined }
        }))
      }

      case 'create_task': {
        const { data, error } = await supabaseAdmin
          .from('tasks')
          .insert({
            task_title: args.task_title,
            description: args.description || null,
            priority: args.priority || 'medium',
            assigned_to: args.assigned_to || 'Antonio',
            due_date: args.due_date || null,
            account_id: args.account_id || null,
            company_name: args.company_name || null,
            category: args.category || 'Admin',
            status: 'To Do',
          })
          .select('id, task_title, status, priority, assigned_to, due_date')
          .single()
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify({ success: true, task: data })
      }

      case 'get_dashboard_stats': {
        const today = new Date().toISOString().split('T')[0]
        const [accounts, openTasks, pendingPayments, overdueDeadlines] = await Promise.all([
          supabaseAdmin.from('accounts').select('status').then(r => {
            const counts: Record<string, number> = {}
            for (const a of r.data ?? []) counts[a.status] = (counts[a.status] || 0) + 1
            return counts
          }),
          supabaseAdmin.from('tasks').select('id', { count: 'exact', head: true }).in('status', ['To Do', 'In Progress', 'Waiting']),
          supabaseAdmin.from('payments').select('amount').eq('status', 'Pending'),
          supabaseAdmin.from('deadlines').select('id', { count: 'exact', head: true }).eq('status', 'Pending').lt('due_date', today),
        ])
        const totalPending = (pendingPayments.data ?? []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
        return JSON.stringify({
          accounts_by_status: accounts,
          open_tasks: openTasks.count ?? 0,
          pending_payments_total: totalPending,
          overdue_deadlines: overdueDeadlines.count ?? 0,
        })
      }

      case 'run_sql_query': {
        const sql = (args.query as string).trim()
        // Safety: only SELECT allowed
        if (!/^SELECT\s/i.test(sql)) {
          return JSON.stringify({ error: 'Only SELECT queries are allowed' })
        }
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(sql)) {
          return JSON.stringify({ error: 'Write operations are not allowed' })
        }
        const { data, error } = await supabaseAdmin.rpc('execute_sql', { query: sql })
        if (error) return JSON.stringify({ error: error.message })
        return JSON.stringify(data ?? [])
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
  } catch (err) {
    console.error(`[ai-agent] Tool ${name} error:`, err)
    return JSON.stringify({ error: `Tool execution failed: ${(err as Error).message}` })
  }
}

// ─── Main handler ───

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 })
  }

  const { messages } = await request.json()
  if (!messages?.length) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 })
  }

  const today = new Date().toISOString().split('T')[0]

  const systemMessage = {
    role: 'system',
    content: `You are the AI assistant for Tony Durante LLC's CRM dashboard. You help Antonio (the admin) manage his US business formation and tax consulting company.

TODAY'S DATE: ${today}

YOUR CAPABILITIES:
- Search and look up accounts, contacts, services, payments, tasks, tax returns, and deadlines
- Create tasks for the team
- Run custom SQL queries for complex questions
- Provide business insights and summaries

RULES:
- Be concise and direct — Antonio is busy
- When showing data, format it clearly with bullet points or short tables
- If multiple accounts match a search, list them and ask which one
- Always reference real data — never make up information
- When creating tasks, confirm what was created
- Match Antonio's language (he speaks English and Italian)
- For complex questions, use run_sql_query with a well-crafted SELECT
- When you reference an account, include a link: [Company Name](/accounts/UUID)
- Amounts should show currency symbol ($, €)

AVAILABLE CRM TABLES: accounts, contacts, account_contacts, services, payments, tasks, deals, tax_returns, deadlines, leads, portal_messages`,
  }

  try {
    let conversationMessages = [systemMessage, ...messages]
    let finalContent = ''
    let iterations = 0
    const maxIterations = 8 // safety limit for tool call loops

    while (iterations < maxIterations) {
      iterations++

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: conversationMessages,
          tools: TOOLS,
          tool_choice: 'auto',
          max_tokens: 2000,
          temperature: 0.3,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        console.error('[ai-agent] OpenAI error:', err)
        return NextResponse.json({ error: 'AI request failed' }, { status: 500 })
      }

      const result = await res.json()
      const choice = result.choices?.[0]

      if (!choice) {
        return NextResponse.json({ error: 'No response from AI' }, { status: 500 })
      }

      const assistantMessage = choice.message

      // If no tool calls, we have the final response
      if (!assistantMessage.tool_calls?.length) {
        finalContent = assistantMessage.content || ''
        break
      }

      // Execute tool calls
      conversationMessages.push(assistantMessage)

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name
        let toolArgs: Record<string, unknown> = {}
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}')
        } catch { /* empty args */ }

        const toolResult = await executeTool(toolName, toolArgs)

        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult,
        })
      }

      // If finish_reason is 'stop' after tool calls, break
      if (choice.finish_reason === 'stop') {
        finalContent = assistantMessage.content || ''
        break
      }
    }

    return NextResponse.json({ content: finalContent })
  } catch (err) {
    console.error('[ai-agent] Error:', err)
    return NextResponse.json({ error: 'AI agent failed' }, { status: 500 })
  }
}
