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
  delivery_id?: string | null
  company_name: string | null
  service_type?: string | null
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
  drive_folder_id: string | null
  notes: string | null
  account_type: string | null
  client_health: string | null
  installment_1_amount: number | null
  installment_1_currency: string | null
  installment_2_amount: number | null
  installment_2_currency: string | null
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
  updated_at: string
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
  account_id: string | null
  contact_id: string | null
  deal_id: string | null
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
  delay_approved_until: string | null
  notes: string | null
  // Invoice fields
  invoice_status: string | null
  issue_date: string | null
  subtotal: number | null
  discount: number | null
  total: number | null
  message: string | null
  sent_at: string | null
  sent_to: string | null
  reminder_count: number | null
  last_reminder_at: string | null
  // QB sync
  qb_invoice_id: string | null
  qb_sync_status: string | null
  qb_sync_error: string | null
  // Billing / credit
  billing_entity_id: string | null
  credit_for_payment_id: string | null
  referral_partner_id: string | null
  // External IDs
  whop_payment_id: string | null
  // Legacy follow-up fields
  reminder_1_sent: string | null
  reminder_2_sent: string | null
  warning_sent: string | null
  restricted_date: string | null
  late_fee_amount: number | null
  penalty_disclaimer_signed: boolean | null
  invoice_date: string | null
  evidence_type: string | null
  payment_record: string | null
  // Metadata
  is_test: boolean | null
  created_at: string
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

// ─── Lead & Contact List Types ───────────────────────────

export interface LeadListItem {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: string | null
  source: string | null
  channel: string | null
  language: string | null
  referrer_name: string | null
  call_date: string | null
  offer_status: string | null
  offer_year1_amount: number | null
  offer_year1_currency: string | null
  created_at: string
}

export interface ContactListItem {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  language: string | null
  citizenship: string | null
  portal_tier: string | null
  status: string | null
  itin_number: string | null
  passport_on_file: boolean | null
  account_count: number
  account_names: string | null
  created_at: string
}

// ─── Contact Detail Types ────────────────────────────────

export interface LinkedAccount {
  id: string
  company_name: string
  entity_type: string | null
  status: string | null
  state_of_formation: string | null
  ein: string | null
  role: string | null
  ownership_pct: number | null
}

export interface ServiceDelivery {
  id: string
  service_name: string | null
  service_type: string | null
  pipeline: string | null
  stage: string | null
  status: string | null
  assigned_to: string | null
  account_id: string | null
  contact_id: string | null
  start_date: string | null
  updated_at: string
}

export interface ConversationEntry {
  id: string
  topic: string | null
  channel: string | null
  direction: string | null
  client_message: string | null
  response_sent: string | null
  category: string | null
  handled_by: string | null
  created_at: string
}

// ─── Portal Types ────────────────────────────────────────

export interface PortalAccount {
  id: string
  company_name: string
  entity_type: string | null
  state_of_formation: string | null
  ein_number: string | null
  formation_date: string | null
  status: string
  physical_address: string | null
  account_type: string | null
}

export interface PortalDocument {
  id: string
  file_name: string
  document_type_name: string | null
  category: number | null
  account_id: string
  drive_file_id: string | null
  processed_at: string | null
  created_at: string
}

export interface PortalService {
  id: string
  service_name: string
  service_type: string
  status: string | null
  current_step: number | null
  total_steps: number | null
  current_stage: string | null
  blocked_waiting_external: boolean | null
  blocked_reason: string | null
  start_date: string | null
}

export interface ClientCustomer {
  id: string
  account_id: string
  name: string
  email: string | null
  address: string | null
  vat_number: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ClientInvoice {
  id: string
  account_id: string
  customer_id: string
  invoice_number: string
  status: string
  currency: 'USD' | 'EUR'
  subtotal: number
  discount: number
  total: number
  tax_total: number
  amount_paid: number
  amount_due: number
  issue_date: string
  due_date: string | null
  paid_date: string | null
  notes: string | null
  message: string | null
  recurring_frequency: string | null
  recurring_next_date: string | null
  recurring_end_date: string | null
  recurring_parent_id: string | null
  parent_invoice_id: string | null
  created_at: string
  updated_at: string
  // Joined
  customer_name?: string
}

export interface ClientCreditNote {
  id: string
  account_id: string | null
  contact_id: string | null
  credit_note_number: string
  original_invoice_id: string
  applied_to_invoice_id: string | null
  amount: number
  reason: string | null
  status: 'issued' | 'applied' | 'voided'
  created_at: string
  updated_at: string
}

export interface ClientInvoiceItem {
  id: string
  invoice_id: string
  description: string
  quantity: number
  unit_price: number
  amount: number
  tax_rate: number
  tax_amount: number
  sort_order: number
}

export interface PortalMessage {
  id: string
  account_id: string
  sender_type: 'client' | 'admin'
  sender_id: string
  sender_name: string | null
  contact_id: string | null
  message: string
  attachment_url: string | null
  attachment_name: string | null
  read_at: string | null
  reply_to_id: string | null
  created_at: string
}

export interface PortalNotification {
  id: string
  account_id: string
  contact_id: string
  type: string
  title: string
  body: string
  link: string | null
  read_at: string | null
  created_at: string
}

// ─── Inbox Types ─────────────────────────────────────────

export type InboxChannel = 'whatsapp' | 'telegram' | 'gmail' | 'portal'

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
  hasAttachment?: boolean
}

export interface InboxAttachment {
  filename: string
  mimeType: string
  size: number
  attachmentId: string
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
  attachments?: InboxAttachment[]
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

// Service Delivery Tracker types
export interface ServiceDelivery {
  id: string
  service_name: string
  service_type: string
  pipeline: string | null
  stage: string | null
  stage_order: number | null
  stage_entered_at: string | null
  account_id: string | null
  contact_id: string | null
  deal_id: string | null
  status: string
  assigned_to: string | null
  amount: number | null
  amount_currency: string | null
  notes: string | null
  start_date: string | null
  end_date: string | null
  updated_at: string
  created_at: string
  // Joined fields
  company_name?: string | null
  tasks?: Task[]
  task_count?: number
  open_task_count?: number
}

export interface PipelineStage {
  id: string
  service_type: string
  stage_name: string
  stage_order: number
  auto_tasks: { title: string; assigned_to: string; category: string; priority: string }[] | null
  requires_approval: boolean
}

export interface TrackerColumn {
  stage: PipelineStage
  deliveries: ServiceDelivery[]
}

// ─── Global Search Types ────────────────────────────────

export interface SearchPreview {
  // Accounts
  ein?: string | null
  state?: string | null
  entity_type?: string | null
  status?: string | null
  formation_date?: string | null
  contacts?: { name: string; email?: string | null; phone?: string | null; role?: string | null }[]
  // Contacts
  email?: string | null
  phone?: string | null
  companies?: { name: string; id: string }[]
  // Tasks
  priority?: string | null
  assigned_to?: string | null
  description?: string | null
  // Leads
  source?: string | null
  reason?: string | null
  channel?: string | null
  // Portal — Documents
  document_type?: string | null
  category?: string | null
  // Portal — Services
  service_type?: string | null
  stage?: string | null
  // Portal — Invoices/Deadlines
  amount?: number | null
  currency?: string | null
  due_date?: string | null
}

export type SearchResultType =
  | 'account' | 'task' | 'lead' | 'contact' | 'chat'
  | 'document' | 'service' | 'invoice' | 'deadline'

export interface EnhancedSearchResult {
  id: string
  title: string
  subtitle?: string
  type: SearchResultType
  href: string
  preview: SearchPreview
}
