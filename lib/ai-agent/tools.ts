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
    description: 'Search contacts AND leads by name or email. Use this when looking for a person. Returns linked accounts for contacts and lead details for leads.',
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
    name: 'gmail_search',
    description: 'Search Gmail inbox (support@tonydurante.us). Returns email summaries with message IDs. IMPORTANT: To find emails from a client, FIRST use search_contacts to get their email address, then search with "from:their@email.com". Searching by name alone may not work. WORKFLOW: 1) search_contacts → get email, 2) gmail_search with from:email, 3) gmail_read for full content, 4) gmail_get_attachments to save to Drive, 5) update_task + update_contact.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query. ALWAYS use "from:email@address.com" to search by sender (not by name). Examples: "from:mario@example.com", "from:client@email.com has:attachment", "from:client@email.com newer_than:7d". Supports all Gmail operators.' },
        max_results: { type: 'number', description: 'Max results to return (default 10, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read',
    description: 'Read a specific email by message ID. Returns from, to, subject, date, body text, and attachment list (with IDs). Use the attachment IDs with gmail_get_attachments or drive_upload_file to save to Drive.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search results)' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_read_thread',
    description: 'Read all messages in an email thread by thread ID. Returns the full conversation. Use to understand the full context of an email exchange.',
    parameters: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID (from gmail_search results)' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'update_task',
    description: 'Update an existing CRM task status, notes, or other fields.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'UUID of the task to update' },
        status: { type: 'string', enum: ['To Do', 'In Progress', 'Waiting', 'Done'], description: 'New status' },
        notes: { type: 'string', description: 'Update task notes (appends to existing)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'New priority' },
        assigned_to: { type: 'string', description: 'New assignee' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_account_notes',
    description: 'Append a note to an account record. Use this to log actions taken on client accounts.',
    parameters: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'UUID of the account' },
        note: { type: 'string', description: 'Note to append (will be timestamped automatically)' },
      },
      required: ['account_id', 'note'],
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
  // ── Knowledge Base & SOPs ──
  {
    name: 'search_kb',
    description: 'Search business knowledge articles by keyword. Contains pricing rules, banking partners, business rules, SOPs, tone guidelines, and operational procedures. ALWAYS use this before performing any action to check if there are rules that apply.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword (e.g. "drive folder", "passport", "pricing", "formation", "banking")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_sop',
    description: 'Get the full Standard Operating Procedure (SOP) for a service type. Contains step-by-step workflows, Drive folder structure, rules, and pipeline stages. Service types: Company Formation, EIN Application, Banking Fintech, Banking Physical, Client Onboarding, ITIN, Tax Return, Company Closure, CMRA, RA Renewal, State Annual Report, Shipping, Public Notary, Support, Offboarding.',
    parameters: {
      type: 'object',
      properties: {
        service_type: { type: 'string', description: 'Service type name (e.g. "Company Formation", "Tax Return", "Client Onboarding")' },
      },
      required: ['service_type'],
    },
  },
  // ── Google Drive Tools ──
  {
    name: 'drive_search',
    description: 'Search Google Drive files/folders by name on the Shared Drive. Use mime_type "application/vnd.google-apps.folder" to search for folders only. To find a client folder, search by their name or company name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term (file name or keyword)' },
        mime_type: { type: 'string', description: 'Optional MIME type filter (e.g. application/pdf, application/vnd.google-apps.folder for folders)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_list_folder',
    description: 'List contents of a Google Drive folder by folder ID.',
    parameters: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Google Drive folder ID' },
      },
      required: ['folder_id'],
    },
  },
  {
    name: 'drive_move',
    description: 'Move a Google Drive file to a different folder.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File ID to move' },
        target_folder_id: { type: 'string', description: 'Destination folder ID' },
      },
      required: ['file_id', 'target_folder_id'],
    },
  },
  {
    name: 'drive_upload_file',
    description: 'Upload a file to Google Drive from a URL or Gmail attachment. WORKFLOW for Gmail attachments: 1) gmail_search to find email, 2) gmail_get_attachments to list attachments and get attachment_id, 3) Use this tool with gmail_message_id + attachment_id + folder_id to save to Drive. To find the client Drive folder: use drive_search with client name + mime_type "application/vnd.google-apps.folder", or check contact.gdrive_folder_url via get_account_detail.',
    parameters: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Name for the uploaded file (include extension, e.g. "Passport - John Smith.png")' },
        folder_id: { type: 'string', description: 'Target Drive folder ID' },
        source_url: { type: 'string', description: 'URL to download the file from (optional)' },
        gmail_message_id: { type: 'string', description: 'Gmail message ID containing the attachment' },
        attachment_id: { type: 'string', description: 'Gmail attachment ID (from gmail_get_attachments results)' },
        mime_type: { type: 'string', description: 'MIME type of the file (e.g. image/png, application/pdf)' },
      },
      required: ['file_name', 'folder_id'],
    },
  },
  // ── Gmail Attachment Tool ──
  {
    name: 'gmail_get_attachments',
    description: 'List or save attachments from a Gmail message. Without save_to_drive: returns attachment list with IDs, filenames, sizes. With save_to_drive=true + drive_folder_id: downloads and uploads all attachments to Drive. IMPORTANT: To find the right Drive folder, first use drive_search with client name + mime_type "application/vnd.google-apps.folder".',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID (from gmail_search results)' },
        save_to_drive: { type: 'boolean', description: 'If true, download all attachments and upload to drive_folder_id' },
        drive_folder_id: { type: 'string', description: 'Target Drive folder ID. Find via drive_search with client name. Required if save_to_drive=true.' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'preview_attachment',
    description: 'Preview an image attachment from a Gmail email. Returns an inline image that will be displayed in the chat. Use this when Antonio asks to see/show/preview an attachment before saving it. Only works for images (PNG, JPG, GIF). For PDFs or other files, save to Drive first and provide the link.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
        attachment_id: { type: 'string', description: 'Attachment ID (from gmail_get_attachments or gmail_read results)' },
        mime_type: { type: 'string', description: 'MIME type of the attachment (e.g. image/png, image/jpeg)' },
      },
      required: ['message_id', 'attachment_id'],
    },
  },
  // ── CRM Update Tools ──
  {
    name: 'update_service',
    description: 'Update a service record: status, current_step, or notes.',
    parameters: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'UUID of the service' },
        status: { type: 'string', description: 'New status: Not Started, In Progress, Waiting Client, Waiting Third Party, Completed, Cancelled' },
        current_step: { type: 'number', description: 'New current step number' },
        notes: { type: 'string', description: 'Notes to append (timestamped)' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'update_contact',
    description: 'Update a contact record. After saving a passport to Drive, set passport_on_file=true and gdrive_folder_url to the folder link.',
    parameters: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'UUID of the contact' },
        passport_on_file: { type: 'boolean', description: 'Set to true after passport is saved to Drive' },
        gdrive_folder_url: { type: 'string', description: 'Google Drive folder URL for this contact' },
        notes: { type: 'string', description: 'Notes to append (timestamped)' },
        phone: { type: 'string', description: 'Updated phone number' },
        language: { type: 'string', description: 'Preferred language' },
        citizenship: { type: 'string', description: 'Country of citizenship' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'advance_service_stage',
    description: 'Advance a service delivery to the next pipeline stage. Finds the service_delivery record for a given service_id, then moves it to the next stage. Automatically creates auto-tasks defined in pipeline_stages.',
    parameters: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'UUID of the service (will look up the active service_delivery)' },
        notes: { type: 'string', description: 'Optional notes about why this stage was advanced' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'log_conversation',
    description: 'Log a client conversation/interaction in the CRM. Use after handling a WhatsApp, email, or call to maintain communication history.',
    parameters: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Account UUID' },
        contact_id: { type: 'string', description: 'Contact UUID' },
        channel: { type: 'string', description: 'Channel: WhatsApp, Email, Phone, Calendly, Telegram' },
        topic: { type: 'string', description: 'Brief topic/subject of the conversation' },
        category: { type: 'string', description: 'Category (e.g., Support, Billing, Onboarding, Tax)' },
        client_message: { type: 'string', description: 'Summary of what the client said' },
        response_sent: { type: 'string', description: 'Summary of the response sent' },
        direction: { type: 'string', description: 'Direction: inbound, outbound' },
      },
      required: ['topic'],
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
      case 'gmail_search': return await gmailSearch(params)
      case 'gmail_read': return await gmailRead(params)
      case 'gmail_read_thread': return await gmailReadThread(params)
      case 'update_task': return await updateTask(params)
      case 'update_account_notes': return await updateAccountNotes(params)
      case 'run_sql_query': return await runSqlQuery(params)
      case 'search_kb': return await searchKb(params)
      case 'get_sop': return await getSop(params)
      case 'drive_search': return await driveSearchTool(params)
      case 'drive_list_folder': return await driveListFolderTool(params)
      case 'drive_move': return await driveMoveTool(params)
      case 'drive_upload_file': return await driveUploadFileTool(params)
      case 'gmail_get_attachments': return await gmailGetAttachmentsTool(params)
      case 'preview_attachment': return await previewAttachmentTool(params)
      case 'update_service': return await updateService(params)
      case 'update_contact': return await updateContact(params)
      case 'advance_service_stage': return await advanceServiceStage(params)
      case 'log_conversation': return await logConversation(params)
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

  const contacts = (data ?? []).map(c => ({ type: 'contact' as const, ...c, accounts: linkMap.get(c.id) ?? [] }))

  // Also search leads
  const leadPattern = `%${p.query}%`
  const { data: leads } = await supabaseAdmin
    .from('leads')
    .select('id, full_name, first_name, last_name, email, phone, status, source, reason, notes, offer_status, created_at')
    .or(`full_name.ilike.${leadPattern},email.ilike.${leadPattern},first_name.ilike.${leadPattern},last_name.ilike.${leadPattern}`)
    .limit(10)

  const leadResults = (leads ?? []).map(l => ({ type: 'lead' as const, ...l }))

  return JSON.stringify({ contacts, leads: leadResults, total: contacts.length + leadResults.length })
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
    .select('id, full_name, first_name, last_name, email, phone, status, source, reason, channel, notes, offer_status, created_at')
    .order('created_at', { ascending: false })
    .limit(Number(p.limit) || 15)
  if (p.query) query = query.or(`full_name.ilike.%${p.query}%,email.ilike.%${p.query}%,first_name.ilike.%${p.query}%,last_name.ilike.%${p.query}%`)
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

// ============================================================
// Gmail Tools
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gmailSearch(p: any) {
  const { gmailGet } = await import('@/lib/gmail')
  const maxResults = Math.min(Number(p.max_results) || 10, 20)

  // Search messages
  const searchResult = await gmailGet('/messages', {
    q: p.query,
    maxResults: String(maxResults),
  }) as { messages?: Array<{ id: string; threadId: string }> }

  if (!searchResult.messages?.length) {
    return JSON.stringify({ results: [], total: 0, message: 'No emails found matching the search query.' })
  }

  // Fetch headers for each message (in parallel, max 10)
  const messagesToFetch = searchResult.messages.slice(0, maxResults)
  const details = await Promise.all(
    messagesToFetch.map(async (msg) => {
      try {
        const detail = await gmailGet(`/messages/${msg.id}`, { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] }) as {
          id: string
          threadId: string
          snippet: string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          payload?: { headers?: Array<{ name: string; value: string }> }
          labelIds?: string[]
        }
        const headers = detail.payload?.headers || []
        const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
        return {
          id: detail.id,
          thread_id: detail.threadId,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          snippet: detail.snippet,
          is_unread: detail.labelIds?.includes('UNREAD') || false,
        }
      } catch {
        return { id: msg.id, thread_id: msg.threadId, error: 'Failed to fetch' }
      }
    })
  )

  return JSON.stringify({ results: details, total: details.length })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gmailRead(p: any) {
  const { gmailGet } = await import('@/lib/gmail')

  const detail = await gmailGet(`/messages/${p.message_id}`, { format: 'full' }) as {
    id: string
    threadId: string
    snippet: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload?: any
    labelIds?: string[]
  }

  const headers = detail.payload?.headers || []
  const getHeader = (name: string) => headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

  // Extract body text
  let bodyText = ''
  function extractText(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      bodyText += Buffer.from(part.body.data, 'base64url').toString('utf-8')
    } else if (part.parts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const sub of part.parts as any[]) extractText(sub)
    }
  }
  if (detail.payload) extractText(detail.payload)

  // Fallback to snippet if no plain text found
  if (!bodyText) bodyText = detail.snippet || ''

  // Truncate very long emails
  if (bodyText.length > 5000) bodyText = bodyText.slice(0, 5000) + '\n...[truncated]'

  return JSON.stringify({
    id: detail.id,
    thread_id: detail.threadId,
    from: getHeader('From'),
    to: getHeader('To'),
    subject: getHeader('Subject'),
    date: getHeader('Date'),
    body: bodyText,
    is_unread: detail.labelIds?.includes('UNREAD') || false,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gmailReadThread(p: any) {
  const { gmailGet } = await import('@/lib/gmail')

  const thread = await gmailGet(`/threads/${p.thread_id}`, { format: 'full' }) as {
    id: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages?: any[]
  }

  if (!thread.messages?.length) {
    return JSON.stringify({ thread_id: p.thread_id, messages: [], error: 'Thread not found or empty' })
  }

  const msgs = thread.messages.map((msg) => {
    const headers = msg.payload?.headers || []
    const getHeader = (name: string) => headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

    let bodyText = ''
    function extractText(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        bodyText += Buffer.from(part.body.data, 'base64url').toString('utf-8')
      } else if (part.parts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const sub of part.parts as any[]) extractText(sub)
      }
    }
    if (msg.payload) extractText(msg.payload)
    if (!bodyText) bodyText = msg.snippet || ''
    if (bodyText.length > 3000) bodyText = bodyText.slice(0, 3000) + '\n...[truncated]'

    return {
      id: msg.id,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      body: bodyText,
    }
  })

  return JSON.stringify({ thread_id: p.thread_id, messages: msgs })
}

// ============================================================
// CRM Update Tools
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateTask(p: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {}
  if (p.status) updates.status = p.status
  if (p.priority) updates.priority = p.priority
  if (p.assigned_to) updates.assigned_to = p.assigned_to

  // Handle notes — append to existing
  if (p.notes) {
    const { data: existing } = await supabaseAdmin.from('tasks').select('notes').eq('id', p.task_id).single()
    const timestamp = new Date().toISOString().split('T')[0]
    const existingNotes = existing?.notes || ''
    updates.notes = existingNotes ? `${existingNotes}\n${timestamp}: ${p.notes}` : `${timestamp}: ${p.notes}`
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'No fields to update. Provide status, notes, priority, or assigned_to.' })
  }

  updates.updated_at = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .update(updates)
    .eq('id', p.task_id)
    .select('id, task_title, status, priority, assigned_to, notes')
    .single()
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, task: data })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateAccountNotes(p: any) {
  const { data: existing } = await supabaseAdmin.from('accounts').select('notes').eq('id', p.account_id).single()
  const timestamp = new Date().toISOString().split('T')[0]
  const existingNotes = existing?.notes || ''
  const newNotes = existingNotes ? `${existingNotes}\n${timestamp}: ${p.note}` : `${timestamp}: ${p.note}`

  const { error } = await supabaseAdmin
    .from('accounts')
    .update({ notes: newNotes })
    .eq('id', p.account_id)
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, message: `Note added to account` })
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

// ============================================================
// Knowledge Base & SOPs
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function searchKb(p: any) {
  const pattern = `%${p.query}%`
  const { data, error } = await supabaseAdmin
    .from('knowledge_articles')
    .select('id, title, category, content')
    .or(`title.ilike.${pattern},content.ilike.${pattern},category.ilike.${pattern}`)
    .limit(5)

  if (error) return JSON.stringify({ error: error.message })
  if (!data?.length) return JSON.stringify({ results: [], message: 'No knowledge articles found. Try different keywords.' })

  // Return titles + truncated content (first 500 chars) for overview, full content for top match
  const results = data.map((a, i) => ({
    title: a.title,
    category: a.category,
    content: i === 0 ? a.content : a.content?.slice(0, 500) + (a.content?.length > 500 ? '...' : ''),
  }))

  return JSON.stringify({ results, total: results.length })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSop(p: any) {
  const { data, error } = await supabaseAdmin
    .from('sop_runbooks')
    .select('id, title, service_type, content, version')
    .ilike('service_type', `%${p.service_type}%`)
    .limit(1)
    .single()

  if (error) {
    // Try title match as fallback
    const { data: fallback } = await supabaseAdmin
      .from('sop_runbooks')
      .select('id, title, service_type, content, version')
      .ilike('title', `%${p.service_type}%`)
      .limit(1)
      .single()

    if (fallback) return JSON.stringify({ title: fallback.title, service_type: fallback.service_type, content: fallback.content })
    return JSON.stringify({ error: `No SOP found for "${p.service_type}". Available: Company Formation, EIN Application, Banking Fintech, Banking Physical, Client Onboarding, ITIN, Tax Return, Company Closure, CMRA, RA Renewal, State Annual Report, Shipping, Public Notary, Support, Offboarding.` })
  }

  return JSON.stringify({ title: data.title, service_type: data.service_type, content: data.content })
}

// ============================================================
// Google Drive Tools
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function driveSearchTool(p: any) {
  const { searchFiles } = await import('@/lib/google-drive')
  const result = await searchFiles(p.query, p.mime_type || undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files = (result as any).files || []
  return JSON.stringify({ files, total: files.length })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function driveListFolderTool(p: any) {
  const { listFolder } = await import('@/lib/google-drive')
  const result = await listFolder(p.folder_id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const files = (result as any).files || []
  return JSON.stringify({ files, total: files.length })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function driveMoveTool(p: any) {
  const { moveFile } = await import('@/lib/google-drive')
  const result = await moveFile(p.file_id, p.target_folder_id)
  return JSON.stringify({ success: true, file: result })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function driveUploadFileTool(p: any) {
  const { uploadBinaryToDrive } = await import('@/lib/google-drive')

  let fileBuffer: Buffer
  let mimeType = p.mime_type || 'application/octet-stream'

  if (p.gmail_message_id && p.attachment_id) {
    // Download from Gmail attachment
    const { getGmailAttachment } = await import('@/lib/gmail')
    const attachment = await getGmailAttachment(p.gmail_message_id, p.attachment_id)
    fileBuffer = attachment.data
  } else if (p.source_url) {
    // Download from URL
    const res = await fetch(p.source_url)
    if (!res.ok) throw new Error(`Failed to download from URL: ${res.status} ${res.statusText}`)
    const contentType = res.headers.get('content-type')
    if (contentType && mimeType === 'application/octet-stream') mimeType = contentType
    const arrayBuffer = await res.arrayBuffer()
    fileBuffer = Buffer.from(arrayBuffer)
  } else {
    return JSON.stringify({ error: 'Provide either source_url or gmail_message_id + attachment_id' })
  }

  const result = await uploadBinaryToDrive(p.file_name, fileBuffer, mimeType, p.folder_id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const file = result as any
  return JSON.stringify({ success: true, file_id: file.id, name: file.name, web_link: file.webViewLink || null })
}

// ============================================================
// Gmail Attachment Tool
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gmailGetAttachmentsTool(p: any) {
  const { gmailGet } = await import('@/lib/gmail')

  // Get full message to find attachments
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const detail = await gmailGet(`/messages/${p.message_id}`, { format: 'full' }) as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function findAttachments(part: any) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      })
    }
    if (part.parts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const sub of part.parts) findAttachments(sub)
    }
  }
  if (detail.payload) findAttachments(detail.payload)

  if (attachments.length === 0) {
    return JSON.stringify({ attachments: [], total: 0, message: 'No attachments found in this email.' })
  }

  // If save_to_drive requested, download each and upload
  if (p.save_to_drive && p.drive_folder_id) {
    const { getGmailAttachment } = await import('@/lib/gmail')
    const { uploadBinaryToDrive } = await import('@/lib/google-drive')

    const uploaded: Array<{ filename: string; drive_file_id: string }> = []
    const failed: Array<{ filename: string; error: string }> = []

    for (const att of attachments) {
      try {
        const attData = await getGmailAttachment(p.message_id, att.attachmentId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const driveFile = await uploadBinaryToDrive(att.filename, attData.data, att.mimeType, p.drive_folder_id) as any
        uploaded.push({ filename: att.filename, drive_file_id: driveFile.id })
      } catch (err) {
        failed.push({ filename: att.filename, error: err instanceof Error ? err.message : 'Unknown error' })
      }
    }

    return JSON.stringify({
      attachments: attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
      total: attachments.length,
      uploaded,
      failed: failed.length > 0 ? failed : undefined,
    })
  }

  return JSON.stringify({
    attachments: attachments.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      attachmentId: a.attachmentId,
    })),
    total: attachments.length,
    hint: 'To save to Drive: call gmail_get_attachments again with save_to_drive=true and drive_folder_id. Or use drive_upload_file with gmail_message_id + attachment_id for a specific file. Find the client folder with drive_search(client_name, mime_type="application/vnd.google-apps.folder").',
  })
}

// ============================================================
// Attachment Preview Tool
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function previewAttachmentTool(p: any) {
  const mimeType = p.mime_type || 'image/png'

  // Only images can be previewed inline
  if (!mimeType.startsWith('image/')) {
    return JSON.stringify({
      error: 'Only image attachments can be previewed. For PDFs and other files, save to Drive first and share the link.',
    })
  }

  // Return a preview URL that the chat UI will render as an image
  const previewUrl = `/api/ai-agent/attachment-preview?message_id=${encodeURIComponent(p.message_id)}&attachment_id=${encodeURIComponent(p.attachment_id)}&mime_type=${encodeURIComponent(mimeType)}`

  return JSON.stringify({
    preview_url: previewUrl,
    mime_type: mimeType,
    message: `Here is the attachment preview. Include this in your response as an image: ![Attachment Preview](${previewUrl})`,
  })
}

// ============================================================
// CRM Update Tools (additional)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateService(p: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {}
  if (p.status) updates.status = p.status
  if (p.current_step !== undefined) updates.current_step = p.current_step

  // Handle notes — append to existing
  if (p.notes) {
    const { data: existing } = await supabaseAdmin.from('services').select('notes').eq('id', p.service_id).single()
    const timestamp = new Date().toISOString().split('T')[0]
    const existingNotes = existing?.notes || ''
    updates.notes = existingNotes ? `${existingNotes}\n${timestamp}: ${p.notes}` : `${timestamp}: ${p.notes}`
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'No fields to update. Provide status, current_step, or notes.' })
  }

  updates.updated_at = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from('services')
    .update(updates)
    .eq('id', p.service_id)
    .select('id, service_name, service_type, status, current_step, total_steps, notes')
    .single()
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, service: data })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateContact(p: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {}
  if (p.passport_on_file !== undefined) updates.passport_on_file = p.passport_on_file
  if (p.gdrive_folder_url) updates.gdrive_folder_url = p.gdrive_folder_url
  if (p.phone) updates.phone = p.phone
  if (p.language) updates.language = p.language
  if (p.citizenship) updates.citizenship = p.citizenship

  // Handle notes — append to existing
  if (p.notes) {
    const { data: existing } = await supabaseAdmin.from('contacts').select('notes').eq('id', p.contact_id).single()
    const timestamp = new Date().toISOString().split('T')[0]
    const existingNotes = existing?.notes || ''
    updates.notes = existingNotes ? `${existingNotes}\n${timestamp}: ${p.notes}` : `${timestamp}: ${p.notes}`
  }

  if (Object.keys(updates).length === 0) {
    return JSON.stringify({ error: 'No fields to update. Provide passport_on_file, gdrive_folder_url, notes, phone, language, or citizenship.' })
  }

  updates.updated_at = new Date().toISOString()
  const { data, error } = await supabaseAdmin
    .from('contacts')
    .update(updates)
    .eq('id', p.contact_id)
    .select('id, full_name, email, phone, language, citizenship, passport_on_file, notes')
    .single()
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, contact: data })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function advanceServiceStage(p: any) {
  // Find the active service_delivery for this service
  const { data: delivery, error: dErr } = await supabaseAdmin
    .from('service_deliveries')
    .select('*')
    .eq('service_id', p.service_id)
    .eq('status', 'active')
    .limit(1)
    .single()

  if (dErr || !delivery) {
    return JSON.stringify({ error: `No active service delivery found for service ${p.service_id}. Error: ${dErr?.message || 'not found'}` })
  }

  // Get current stage order
  const currentStageOrder = delivery.stage_order || 0

  // Get the next stage from pipeline_stages
  const { data: nextStage, error: sErr } = await supabaseAdmin
    .from('pipeline_stages')
    .select('*')
    .eq('service_type', delivery.service_type)
    .gt('stage_order', currentStageOrder)
    .order('stage_order')
    .limit(1)
    .single()

  if (sErr || !nextStage) {
    return JSON.stringify({ error: `No next stage found for service type "${delivery.service_type}" after stage_order ${currentStageOrder}. The delivery may already be at the final stage.` })
  }

  // Update delivery to the next stage
  const isCompleted = nextStage.is_final === true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliveryUpdate: Record<string, any> = {
    stage: nextStage.stage_name,
    stage_order: nextStage.stage_order,
    updated_at: new Date().toISOString(),
  }
  if (isCompleted) {
    deliveryUpdate.status = 'completed'
    deliveryUpdate.completed_at = new Date().toISOString()
  }
  if (p.notes) {
    const existingNotes = delivery.notes || ''
    const timestamp = new Date().toISOString().split('T')[0]
    deliveryUpdate.notes = existingNotes ? `${existingNotes}\n${timestamp}: ${p.notes}` : `${timestamp}: ${p.notes}`
  }

  const { error: uErr } = await supabaseAdmin
    .from('service_deliveries')
    .update(deliveryUpdate)
    .eq('id', delivery.id)
  if (uErr) return JSON.stringify({ error: `Failed to advance stage: ${uErr.message}` })

  // Create auto-tasks if the stage defines them
  const createdTasks: string[] = []
  if (nextStage.auto_tasks && Array.isArray(nextStage.auto_tasks)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const taskDef of nextStage.auto_tasks as Array<{ title: string; assigned_to: string; category: string; priority: string; description?: string }>) {
      const { error: tErr } = await supabaseAdmin
        .from('tasks')
        .insert({
          task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
          assigned_to: taskDef.assigned_to || 'Luca',
          category: taskDef.category || 'Internal',
          priority: taskDef.priority || 'Normal',
          description: taskDef.description || `Auto-created by pipeline advance to "${nextStage.stage_name}"`,
          status: 'To Do',
          account_id: delivery.account_id,
          deal_id: delivery.deal_id,
          delivery_id: delivery.id,
          stage_order: nextStage.stage_order,
        })
      if (!tErr) createdTasks.push(taskDef.title)
    }
  }

  return JSON.stringify({
    success: true,
    delivery_id: delivery.id,
    previous_stage: delivery.stage || 'New',
    new_stage: nextStage.stage_name,
    is_completed: isCompleted,
    tasks_created: createdTasks,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logConversation(p: any) {
  const insert = {
    account_id: p.account_id || null,
    contact_id: p.contact_id || null,
    channel: p.channel || null,
    topic: p.topic,
    category: p.category || null,
    client_message: p.client_message || null,
    response_sent: p.response_sent || null,
    direction: p.direction || null,
    handled_by: 'AI Agent',
    status: p.response_sent ? 'Sent' : 'New',
  }

  const { data, error } = await supabaseAdmin
    .from('conversations')
    .insert(insert)
    .select('id, topic, channel, status')
    .single()
  if (error) return JSON.stringify({ error: error.message })
  return JSON.stringify({ success: true, conversation: data })
}
