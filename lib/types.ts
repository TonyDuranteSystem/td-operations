export interface Task {
  id: string
  task_title: string
  status: string
  priority: string
  due_date: string | null
  assigned_to: string
  category: string | null
  description: string | null
  account_id: string | null
  company_name: string | null
  updated_at: string
  created_at: string
}

export interface TaskStats {
  total: number
  urgent: number
  waiting: number
  overdue: number
  inProgress: number
}

export interface GroupedTasks {
  urgente: Task[]
  inCorso: Task[]
  normale: Task[]
}

export interface TaxReturn {
  id: string
  company_name: string
  client_name: string | null
  return_type: string
  tax_year: number
  deadline: string
  status: string
  paid: boolean | null
  data_received: boolean | null
  sent_to_india: boolean | null
  india_status: string | null
  special_case: boolean | null
  extension_filed: boolean | null
  extension_deadline: string | null
  notes: string | null
  updated_at: string
}

export interface TaxSection {
  key: string
  title: string
  items: TaxReturn[]
  color: string
  icon: string
}

export interface Account {
  id: string
  company_name: string
  entity_type: string | null
  status: string | null
  ein_number: string | null
  filing_id: string | null
  formation_date: string | null
  state_of_formation: string | null
  physical_address: string | null
  registered_agent: string | null
  ra_renewal_date: string | null
  portal_account: boolean | null
  portal_created_date: string | null
  services_bundle: string[] | null
  cancellation_requested: boolean | null
  cancellation_date: string | null
  referrer: string | null
  lead_source: string | null
  gdrive_folder_url: string | null
  notes: string | null
  client_health: string | null
  created_at: string
  updated_at: string
}

export interface Contact {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  email_2: string | null
  phone: string | null
  phone_2: string | null
  language: string | null
  preferred_channel: string | null
  citizenship: string | null
  residency: string | null
  itin_number: string | null
  itin_issue_date: string | null
  passport_on_file: boolean | null
  notes: string | null
  role?: string | null
}

export interface Service {
  id: string
  service_name: string
  service_type: string
  account_id: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  billing_type: string | null
  amount: number | null
  amount_currency: string | null
  current_step: number | null
  total_steps: number | null
  blocked_waiting_external: boolean | null
  blocked_reason: string | null
  sla_due_date: string | null
  notes: string | null
  updated_at: string
}

export interface Payment {
  id: string
  account_id: string
  description: string | null
  amount: number
  amount_currency: string | null
  period: string | null
  year: number | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  payment_method: string | null
  invoice_number: string | null
  installment: string | null
  amount_paid: number | null
  amount_due: number | null
  followup_stage: string | null
  notes: string | null
  updated_at: string
}

export interface Deal {
  id: string
  deal_name: string
  account_id: string | null
  stage: string | null
  amount: number | null
  amount_currency: string | null
  close_date: string | null
  deal_type: string | null
  deal_category: string | null
  service_type: string | null
  payment_status: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface AccountListItem {
  id: string
  company_name: string
  entity_type: string | null
  status: string | null
  state_of_formation: string | null
  formation_date: string | null
  client_health: string | null
  contact_name: string | null
  contact_email: string | null
  service_count: number
  payment_overdue: number
}

// ─── Inbox Types ─────────────────────────────────────────

export type InboxChannel = 'whatsapp' | 'telegram' | 'gmail'

export interface InboxConversation {
  id: string
  channel: InboxChannel
  name: string
  preview: string
  unread: number
  lastMessageAt: string
  accountId?: string | null
  accountName?: string | null
  contactId?: string | null
  // Gmail-specific
  subject?: string
}

export interface InboxMessage {
  id: string
  direction: 'inbound' | 'outbound'
  sender: string
  content: string
  type: string
  status: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface InboxStats {
  whatsapp: number
  telegram: number
  gmail: number
  total: number
}

export interface GmailThread {
  id: string
  subject: string
  snippet: string
  from: string
  lastDate: string
  unread: boolean
  messageCount: number
}

export interface GmailMessageDetail {
  id: string
  from: string
  to: string
  subject: string
  body: string
  date: string
  labelIds: string[]
}
