import type { MessageReaction } from './portal/reactions'

export interface TaskAttachment {
  /** Publicly accessible URL (typically a Google Drive file URL). */
  url: string
  /** Display name shown on the task card (e.g. "W-7_Antonio_Truocchio.pdf"). */
  name: string
  /** Optional MIME type hint (e.g. "application/pdf"). */
  type?: string
}

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
  contact_id?: string | null
  delivery_id?: string | null
  company_name: string | null
  service_type?: string | null
  /**
   * Optional attachments array (jsonb column on tasks table). Rendered as
   * clickable chips below the task title in the Tasks sub-tab of portal chat
   * (see components/tasks/task-card.tsx). Used for ITIN PDF rescue and any
   * other task that needs a client-facing document link.
   */
  attachments?: TaskAttachment[]
  updated_at: string
  created_at: string
  /**
   * Workflow System fields (Slice 1 migration: 2026-05-15). When
   * workflow_snapshot is non-null, TaskCard delegates rendering to
   * WorkflowTaskCard. See lib/tasks/types.ts for the snapshot shape.
   */
  workflow_slug?: string | null
  workflow_snapshot?: Record<string, unknown> | null
  task_meta?: Record<string, unknown> | null
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
  sent_to_accountant: boolean | null
  accountant_status: string | null
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
  registered_agent_provider: string | null
  ra_renewal_date: string | null
  // Optional: columns exist in sandbox but may be absent in production until
  // the migration ships. Access yields `undefined` when the column is missing;
  // the `?` keeps callers safe via `??` fallback.
  client_since?: string | null
  ra_switch_date?: string | null
  portal_account: boolean | null
  portal_created_date: string | null
  services_bundle: string[] | null
  cancellation_requested: boolean | null
  cancellation_date: string | null
  referrer: string | null
  referred_by: string | null
  referral_commission_pct: number | null
  referral_status: string | null
  partner_id: string | null
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
  communication_email: string | null
  onboarding_date: string | null
  setup_fee_amount: number | null
  setup_fee_invoice: string | null
  setup_fee_date: string | null
  audit_reviewed_at: string | null
  audit_flag: boolean | null
  audit_reviewed_by: string | null
  audit_sections: Record<string, boolean> | null
  business_legal_address_id: string | null
  business_mailing_address_id: string | null
  registered_agent_id: string | null
  legal_link_verified: boolean | null
  mailing_link_verified: boolean | null
  ra_link_verified: boolean | null
  member_structure: 'single_member' | 'multi_member' | null
  // Authoritative member count for MMLLC — source of truth for OA generation
  // pre-flight. Backfilled from ss4_applications.member_count; manually set
  // by staff for legacy/external-filed clients.
  member_count?: number | null
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
  itin: string | null
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
  /** Live current-offer status from the offers table (lowercase: sent/viewed/signed/completed).
   *  Authoritative — unlike the denormalized offer_status snapshot which can be stale. */
  current_offer_status: string | null
  offer_year1_amount: number | null
  offer_year1_currency: string | null
  created_at: string
  /** Set when this booking's email matched an already-established client —
   *  it's a booking record, not an open sales lead (dev job 93580372). */
  existing_client_contact_id: string | null
  /** True when an actual call recording has come back for this lead (via
   *  Circleback), computed server-side — never a guess from call_date. */
  has_call_recording: boolean
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
  member_structure: 'single_member' | 'multi_member' | null
  status: string | null
  state_of_formation: string | null
  ein: string | null
  role: string | null
  ownership_pct: number | null
  account_type: string | null
  autopay_card_enabled: boolean | null
  autopay_card_last4: string | null
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
  member_structure: 'single_member' | 'multi_member' | null
  state_of_formation: string | null
  ein_number: string | null
  formation_date: string | null
  status: string
  physical_address: string | null
  account_type: string | null
  portal_tier?: string | null
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

export interface ChatAttachment {
  url: string
  name: string
  mime_type?: string
  size?: number
}

export interface PortalMessage {
  id: string
  account_id: string | null
  sender_type: 'client' | 'admin' | 'system'
  sender_id: string
  sender_name: string | null
  contact_id: string | null
  sender_context?: 'person' | 'company' | null
  topic?: string | null
  message: string
  attachment_url: string | null
  attachment_name: string | null
  attachments: ChatAttachment[] | null
  read_at: string | null
  reply_to_id: string | null
  created_at: string
  deleted_at?: string | null
  deleted_by?: string | null
  edited_at?: string | null
  original_message?: string | null
  pinned_at?: string | null
  pinned_by?: string | null
  pinned_by_type?: 'client' | 'staff' | null
  client_kept_unread?: boolean
  reactions?: MessageReaction[] | null
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

export type InboxChannel = 'gmail' | 'portal' | 'whatsapp'

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
  /** Color-mark key ('red' | 'orange' | …) from the thread's Marked/* Gmail label */
  colorMark?: string | null
  /** True when this thread was manually linked to the client (email_links) */
  linked?: boolean
  /** Client email views: 'received' = last message is from the client,
   *  'sent' = last message is from us */
  direction?: 'received' | 'sent'
  /** True when the server could not fully load this thread this round (a stub /
   *  carried-forward row) — the UI marks it so it never looks like real data. */
  partial?: boolean
  /** Payload-derived: does any live message of this thread carry INBOX? Absent
   *  on payloads that don't compute it (live-Gmail fallback, chat channels).
   *  false → the row renders an "Archived" chip in folder / all-mail-search
   *  views, where an archived row deliberately stays visible. */
  inInbox?: boolean
  /** Payload-derived: any live message starred. Pin == the Gmail star (syncs
   *  both ways with the Gmail app). Absent on payloads that don't compute it. */
  starred?: boolean
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
  /** True when content is the real text/html MIME part (emails only) */
  isHtml?: boolean
  type: string
  status: string
  createdAt: string
  metadata?: Record<string, unknown>
  attachments?: InboxAttachment[]
  /** Inline (cid:) images used in the body — excluded from `attachments` so the
   *  normal thread view doesn't double-show them as chips, but Forward needs
   *  them to offer the original's images too (Antonio, 2026-08-28). */
  inlineImages?: InboxAttachment[]
}

export interface InboxStats {
  gmail: number
  whatsapp: number
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
