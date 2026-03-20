/**
 * AI Agent Tools — Database query + action tools for the CRM AI Agent.
 * Each tool has a definition (schema) and an execute function.
 * Schema matches actual Supabase tables.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

// ============================================================
// Tool Definitions (used by both Claude and OpenAI)
// ============================================================

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: 'search_accounts',
    description: 'Search CRM accounts by company name, status, state, or entity type.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name search term (partial match)' },
        status: { type: 'string', description: 'Filter by status: Active, Pending, Inactive, Dormant, Dissolved' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
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
  {
    name: 'search_contacts',
    description: 'Search contacts by name or email. Returns linked accounts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or email search term' },
      },
      required: ['query'],
    },
  },
  {
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
    },
  },
  {
    name: 'search_payments',
    description: 'Search payments by status, account, or overdue. Shows outstanding and completed payments.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: Pending, Paid, Overdue, Partial, Cancelled' },
        account_id: { type: 'string', description: 'Filter by account UUID' },
        overdue_only: { type: 'boolean', description: 'Only show overdue payments' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
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
    },
  },
  {
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
    },
  },
  {
    name: 'search_deadlines',
    description: 'Search upcoming or overdue deadlines.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: Pending, Overdue, Completed' },
        account_id: { type: 'string', description: 'Filter by account UUID' },
        days_ahead: { type: 'number', description: 'Show deadlines within N days (default 30)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'search_leads',
    description: 'Search leads (potential clients) by name, email, company, or status.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search by name, email, or company' },
        status: { type: 'string', description: 'Lead status: new, contacted, qualified, converted, lost' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
    },
  },
  {
    name: 'search_deals',
    description: 'Search pipeline deals by stage or name.',
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'Pipeline stage: Lead, Qualified, Proposal, Negotiation, Won, Lost' },
        query: { type: 'string', description: 'Search by deal name' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
    },
  },
  {
    name: 'check_portal_messages',
    description: 'Check recent unread portal chat messages from clients.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Create a new CRM task for the team.',
    parameters: {
      type: 'object',
      properties: {
        task_title: { type: 'string', description: 'Title of the task' },
        description: { type: 'string', description: 'Detailed description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority level' },
        assigned_to: { type: 'string', description: 'Assignee name (e.g. Antonio, Luca)' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        account_id: { type: 'string', description: 'Related account UUID (optional)' },
        category: { type: 'string', description: 'Category: Tax, Formation, Compliance, Admin, Billing, Client Communication' },
      },
      required: ['task_title'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email from support@tonydurante.us to a client or anyone.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body in plain text (will be formatted as HTML)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_dashboard_stats',
    description: 'Get overview dashboard stats: total accounts by status, pending payments, open tasks, upcoming deadlines.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_sql_query',
    description: 'Run a read-only SQL query for complex questions other tools cannot answer. SELECT only. Tables: accounts, contacts, account_contacts, services, payments, tasks, deals, tax_returns, deadlines, leads, portal_messages, offers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'SELECT SQL query' },
      },
      required: ['query'],
    },
  },
]

// ============================================================
// Tool Execution
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(name: string, params: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case 'search_accounts': return await searchAccounts(params)
      case 'get_account_detail': return await getAccountDetail(params)
      case 'search_contacts': return await searchContacts(params)
      case 'search_services': return await searchServices(params)
      case 'search_payments': return await searchPayments(params)
      case 'search_tasks': return await searchTasks(params)
      case 'search_tax_returns': return await searchTaxReturns(params)
      case 'search_deadlines': return await searchDeadlines(params)
      case 'search_leads': return await searchLeads(params)
      case 'search_deals': return await searchDeals(params)
      case 'check_portal_messages': return await checkPortalMessages(params)
      case 'create_task': return await createTask(params)
      case 'send_email': return await sendEmail(params)
      case 'get_dashboard_stats': return await getDashboardStats()
      case 'run_sql_query': return await runSqlQuery(params)
      default: return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
  } catch (err) {
    console.error(`[ai-agent] Tool ${name} error:`, err)
    return JSON.stringify({ error: `Tool ${name} failed: ${err instanceof Error ? err.message : 'Unknown error'}` })
  }
}

// ============================================================
// Tool Implementations (matching actual Supabase schema)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchAccounts(p: any) {
  let query = supabaseAdmin
    .from('accounts')
    .select('id, company_name, entity_type, status, state_of_formation, ein_number, formation_date, client_health')
  if (p.query) query = query.ilike('company_name', `%${p.query}%`)
  if (p.status) query = query.eq('status', p.status)
  const { data, error } = await query.order('company_name').limit(Number(p.limit) || 10)
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getAccountDetail(p: any) {
  const id = p.account_id
  const [account, contacts, services, payments, deadlines, deals] = await Promise.all([
    supabaseAdmin.from('accounts').select('*').eq('id', id).single(),
    supabaseAdmin.from('account_contacts').select('role, contact:contacts(id, full_name, email, phone, language)').eq('account_id', id),
    supabaseAdmin.from('services').select('id, service_name, service_type, status, current_step, total_steps, amount, amount_currency, sla_due_date, notes, updated_at').eq('account_id', id).order('updated_at', { ascending: false }),
    supabaseAdmin.from('payments').select('id, description, amount, amount_currency, status, due_date, paid_date, invoice_number, notes').eq('account_id', id).order('due_date', { ascending: false }).limit(20),
    supabaseAdmin.from('deadlines').select('id, deadline_type, due_date, status, notes').eq('account_id', id).order('due_date').limit(10),
    supabaseAdmin.from('deals').select('id, deal_name, stage, amount, deal_type, notes, created_at').eq('account_id', id).order('created_at', { ascending: false }).limit(10),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchContacts(p: any) {
  const pattern = `%${p.query}%`
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email, phone, language, citizenship')
    .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
    .limit(10)
  if (error) return JSON.stringify({ error: error.message })

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchServices(p: any) {
  let query = supabaseAdmin
    .from('services')
    .select('id, service_name, service_type, status, current_step, total_steps, amount, amount_currency, sla_due_date, account_id, accounts!inner(company_name)')
  if (p.status) query = query.eq('status', p.status)
  if (p.service_type) query = query.eq('service_type', p.service_type)
  if (p.account_id) query = query.eq('account_id', p.account_id)
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(Number(p.limit) || 20)
  if (error) return JSON.stringify({ error: error.message })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.stringify((data ?? []).map((s: any) => {
    const acct = s.accounts as unknown as { company_name: string }
    return { ...s, company_name: acct?.company_name, accounts: undefined }
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchPayments(p: any) {
  const today = new Date().toISOString().split('T')[0]
  let query = supabaseAdmin
    .from('payments')
    .select('id, description, amount, amount_currency, status, due_date, paid_date, invoice_number, account_id, accounts!inner(company_name)')
  if (p.status) query = query.eq('status', p.status)
  if (p.account_id) query = query.eq('account_id', p.account_id)
  if (p.overdue_only) query = query.eq('status', 'Pending').lt('due_date', today)
  const { data, error } = await query.order('due_date', { ascending: false }).limit(Number(p.limit) || 20)
  if (error) return JSON.stringify({ error: error.message })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.stringify((data ?? []).map((p: any) => {
    const acct = p.accounts as unknown as { company_name: string }
    return { ...p, company_name: acct?.company_name, accounts: undefined }
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchTasks(p: any) {
  let query = supabaseAdmin
    .from('tasks')
    .select('id, task_title, status, priority, due_date, assigned_to, category, description, account_id, notes')
  if (p.status) query = query.eq('status', p.status)
  if (p.priority) query = query.eq('priority', p.priority)
  if (p.assigned_to) query = query.ilike('assigned_to', `%${p.assigned_to}%`)
  if (p.query) query = query.ilike('task_title', `%${p.query}%`)
  const { data, error } = await query.order('created_at', { ascending: false }).limit(Number(p.limit) || 20)
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchTaxReturns(p: any) {
  let query = supabaseAdmin
    .from('tax_returns')
    .select('id, company_name, client_name, return_type, tax_year, deadline, status, paid, data_received, extension_filed, extension_deadline, notes, updated_at')
  if (p.company_name) query = query.ilike('company_name', `%${p.company_name}%`)
  if (p.tax_year) query = query.eq('tax_year', p.tax_year)
  if (p.status) query = query.eq('status', p.status)
  const { data, error } = await query.order('tax_year', { ascending: false }).limit(Number(p.limit) || 20)
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchDeadlines(p: any) {
  const daysAhead = Number(p.days_ahead) || 30
  const futureDate = new Date()
  futureDate.setDate(futureDate.getDate() + daysAhead)

  let query = supabaseAdmin
    .from('deadlines')
    .select('id, deadline_type, due_date, status, notes, account_id, accounts!inner(company_name)')
  if (p.status) query = query.eq('status', p.status)
  if (p.account_id) query = query.eq('account_id', p.account_id)
  if (!p.status) query = query.in('status', ['Pending', 'Overdue'])
  query = query.lte('due_date', futureDate.toISOString().split('T')[0])
  const { data, error } = await query.order('due_date').limit(Number(p.limit) || 20)
  if (error) return JSON.stringify({ error: error.message })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.stringify((data ?? []).map((d: any) => {
    const acct = d.accounts as unknown as { company_name: string }
    return { ...d, company_name: acct?.company_name, accounts: undefined }
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchLeads(p: any) {
  let query = supabaseAdmin
    .from('leads')
    .select('id, name, email, company, status, source, service_interest, created_at')
    .order('created_at', { ascending: false })
    .limit(Number(p.limit) || 15)
  if (p.query) query = query.or(`name.ilike.%${p.query}%,email.ilike.%${p.query}%,company.ilike.%${p.query}%`)
  if (p.status) query = query.eq('status', p.status)
  const { data, error } = await query
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchDeals(p: any) {
  let query = supabaseAdmin
    .from('deals')
    .select('id, deal_name, stage, amount, deal_type, notes, account_id, accounts!inner(company_name)')
    .order('created_at', { ascending: false })
    .limit(Number(p.limit) || 15)
  if (p.stage) query = query.eq('stage', p.stage)
  if (p.query) query = query.ilike('deal_name', `%${p.query}%`)
  const { data, error } = await query
  if (error) return JSON.stringify({ error: error.message })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.stringify((data ?? []).map((d: any) => {
    const acct = d.accounts as unknown as { company_name: string }
    return { ...d, company_name: acct?.company_name, accounts: undefined }
  }))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkPortalMessages(p: any) {
  const { data, error } = await supabaseAdmin
    .from('portal_messages')
    .select('id, message, sender_type, created_at, account_id, accounts(company_name)')
    .eq('sender_type', 'client')
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(Number(p.limit) || 10)
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createTask(p: any) {
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .insert({
      task_title: p.task_title,
      description: p.description || null,
      priority: p.priority || 'medium',
      assigned_to: p.assigned_to || 'Antonio',
      due_date: p.due_date || null,
      account_id: p.account_id || null,
      category: p.category || 'Admin',
      status: 'To Do',
    })
    .select('id, task_title, status, priority, assigned_to, due_date')
    .single()
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, task: data })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendEmail(p: any) {
  const { gmailPost } = await import('@/lib/gmail')

  // Escape HTML in body text
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escapedBody = escHtml(p.body)

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="border: 1px solid #e5e7eb; padding: 24px; border-radius: 12px;">
        ${escapedBody.split('\n').map((line: string) => `<p style="margin: 0 0 12px;">${line}</p>`).join('')}
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #6b7280; font-size: 12px;">Tony Durante LLC — Business Formation &amp; Tax Consulting</p>
      </div>
    </div>
  `

  const subject = p.subject
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const boundary = `boundary_${Date.now()}`
  const rawEmail = [
    `From: Tony Durante <support@tonydurante.us>`,
    `To: ${p.to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
    `--${boundary}--`,
  ].join('\r\n')

  await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
  return JSON.stringify({ success: true, message: `Email sent to ${p.to} with subject "${p.subject}"` })
}

async function getDashboardStats() {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSqlQuery(p: any) {
  const sql = (p.query as string).trim()
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
