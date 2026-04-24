// Enum values from CRM-Data-Schema.md — Section 2

export const ACCOUNT_STATUS = [
  'Active', 'Pending Formation', 'Delinquent', 'Suspended', 'Offboarding', 'Cancelled', 'Closed',
] as const

export const COMPANY_TYPE = [
  'Single Member LLC', 'Multi Member LLC', 'C-Corp Elected',
] as const

export const SERVICE_TYPE = [
  'Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal',
  'State Annual Report', 'EIN Application', 'CMRA', 'ITIN',
  'Banking Fintech', 'Banking Physical', 'Shipping', 'Public Notary',
  'Company Closure', 'Client Offboarding', 'Support',
] as const

// SERVICE_STATUS is the old services table ENUM — kept for backward compat
export const SERVICE_STATUS = [
  'Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party', 'Completed', 'Cancelled',
] as const

// SD_STATUS is the canonical set for service_deliveries (enforced by CHECK constraint)
export const SD_STATUS = [
  'active', 'blocked', 'completed', 'cancelled',
] as const

export const OFFER_STATUS = [
  'draft', 'sent', 'viewed', 'accepted', 'signed', 'completed', 'expired',
] as const

export const LEASE_STATUS = [
  'draft', 'sent', 'viewed', 'signed',
] as const

export const OA_STATUS = [
  'draft', 'sent', 'viewed', 'signed', 'partially_signed',
] as const

export const SS4_STATUS = [
  'draft', 'awaiting_signature', 'signed', 'submitted', 'done', 'fax_failed',
] as const

export const DEADLINE_STATUS = [
  'Pending', 'Completed', 'Filed', 'Not Started', 'Overdue', 'Cancelled',
] as const

export const DOCUMENT_STATUS = [
  'classified', 'unclassified', 'error', 'pending',
] as const

export const CLIENT_INVOICE_STATUS = [
  'Draft', 'Sent', 'Paid', 'Partial', 'Cancelled', 'Overdue',
] as const

export const CLIENT_EXPENSE_STATUS = [
  'Pending', 'Paid', 'Overdue', 'Cancelled',
] as const

export const SUBMISSION_STATUS = [
  'pending', 'opened', 'completed', 'reviewed',
] as const

export const PENDING_ACTIVATION_STATUS = [
  'awaiting_payment', 'payment_confirmed', 'activated', 'expired', 'cancelled',
] as const

export const REFERRAL_STATUS = [
  'pending', 'converted', 'credited', 'paid', 'cancelled',
] as const

export const SIGNATURE_REQUEST_STATUS = [
  'draft', 'awaiting_signature', 'signed',
] as const

export const WIZARD_STATUS = [
  'in_progress', 'submitted', 'reviewed',
] as const

// PortalTier moved to lib/portal/tier-config.ts — single canonical source

export const PORTAL_ROLE = [
  'client', 'partner',
] as const

export const DEAL_STAGE = [
  'Initial Consultation', 'Offer Sent', 'Negotiation', 'Agreement Signed', 'Paid', 'Closed Won', 'Closed Lost',
] as const

export const LEAD_STATUS = [
  'New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Paid', 'Converted', 'Lost', 'Suspended',
] as const

export const PAYMENT_STATUS = [
  'Pending', 'Paid', 'Overdue', 'Delinquent', 'Waived', 'Refunded', 'Not Invoiced', 'Cancelled',
] as const

export const PAYMENT_PERIOD = [
  'January', 'June', 'One-Time', 'Custom',
] as const

export const TASK_STATUS = [
  'To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled',
] as const

export const TASK_PRIORITY = [
  'Urgent', 'High', 'Normal', 'Low',
] as const

export const TASK_CATEGORY = [
  'Client Response', 'Document', 'Filing', 'Follow-up', 'Payment',
  'CRM Update', 'Internal', 'KYC', 'Shipping', 'Notarization', 'Client Communication',
] as const

export const TAX_RETURN_TYPE = ['SMLLC', 'MMLLC', 'Corp', 'LSE'] as const

export const TAX_RETURN_STATUS = [
  'Payment Pending', 'Link Sent - Awaiting Data', 'Data Received',
  'Sent to India', 'Extension Filed', 'TR Completed - Awaiting Signature',
  'TR Filed', 'Paid - Not Started', 'Activated - Need Link', 'Not Invoiced',
  'Extension Requested',
] as const

export const CONVERSATION_CHANNEL = [
  'WhatsApp', 'Telegram', 'Email', 'Phone', 'Portal', 'In-Person',
] as const

export const CONVERSATION_STATUS = [
  'New', 'Proposed', 'Approved', 'Sent', 'Archived',
] as const

// OFFER_STATUS moved above (line ~28) with actual DB values (lowercase)

// TypeScript types
export type AccountStatus = (typeof ACCOUNT_STATUS)[number]
export type CompanyType = (typeof COMPANY_TYPE)[number]
export type ServiceType = (typeof SERVICE_TYPE)[number]
export type ServiceStatus = (typeof SERVICE_STATUS)[number]
export type DealStage = (typeof DEAL_STAGE)[number]
export type LeadStatus = (typeof LEAD_STATUS)[number]
export type PaymentStatus = (typeof PAYMENT_STATUS)[number]
export type PaymentPeriod = (typeof PAYMENT_PERIOD)[number]
export type TaskStatus = (typeof TASK_STATUS)[number]
export type TaskPriority = (typeof TASK_PRIORITY)[number]
export type TaskCategory = (typeof TASK_CATEGORY)[number]
export type TaxReturnType = (typeof TAX_RETURN_TYPE)[number]
export type TaxReturnStatus = (typeof TAX_RETURN_STATUS)[number]
export type ConversationChannel = (typeof CONVERSATION_CHANNEL)[number]
export type ConversationStatus = (typeof CONVERSATION_STATUS)[number]
export type OfferStatus = (typeof OFFER_STATUS)[number]
export type SdStatus = (typeof SD_STATUS)[number]
export type LeaseStatus = (typeof LEASE_STATUS)[number]
export type OaStatus = (typeof OA_STATUS)[number]
export type Ss4Status = (typeof SS4_STATUS)[number]
export type DeadlineStatus = (typeof DEADLINE_STATUS)[number]
export type DocumentStatus = (typeof DOCUMENT_STATUS)[number]
export type ClientInvoiceStatus = (typeof CLIENT_INVOICE_STATUS)[number]
export type ClientExpenseStatus = (typeof CLIENT_EXPENSE_STATUS)[number]
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number]
export type PendingActivationStatus = (typeof PENDING_ACTIVATION_STATUS)[number]
export type ReferralStatus = (typeof REFERRAL_STATUS)[number]
export type SignatureRequestStatus = (typeof SIGNATURE_REQUEST_STATUS)[number]
export type WizardStatus = (typeof WIZARD_STATUS)[number]
export type PortalRole = (typeof PORTAL_ROLE)[number]

// Badge color mappings
export const STATUS_COLORS: Record<string, string> = {
  // Account
  'Active': 'bg-emerald-100 text-emerald-800',
  'Pending Formation': 'bg-amber-100 text-amber-800',
  'Delinquent': 'bg-red-100 text-red-800',
  'Suspended': 'bg-orange-100 text-orange-800',
  'Offboarding': 'bg-amber-100 text-amber-800',
  'Cancelled': 'bg-zinc-100 text-zinc-800',
  'Closed': 'bg-zinc-100 text-zinc-800',
  // Task
  'To Do': 'bg-zinc-100 text-zinc-800',
  'In Progress': 'bg-blue-100 text-blue-800',
  'Waiting': 'bg-amber-100 text-amber-800',
  'Done': 'bg-emerald-100 text-emerald-800',
  // Service
  'Not Started': 'bg-zinc-100 text-zinc-800',
  'Waiting Client': 'bg-amber-100 text-amber-800',
  'Waiting Third Party': 'bg-orange-100 text-orange-800',
  'Completed': 'bg-emerald-100 text-emerald-800',
  // Payment
  'Pending': 'bg-amber-100 text-amber-800',
  'Paid': 'bg-emerald-100 text-emerald-800',
  'Overdue': 'bg-red-100 text-red-800',
  'Waived': 'bg-zinc-100 text-zinc-800',
  'Refunded': 'bg-purple-100 text-purple-800',
  // Priority
  'Urgent': 'bg-red-100 text-red-800',
  'High': 'bg-orange-100 text-orange-800',
  'Normal': 'bg-blue-100 text-blue-800',
  'Low': 'bg-zinc-100 text-zinc-800',
  // SD status (lowercase)
  'active': 'bg-emerald-100 text-emerald-800',
  'blocked': 'bg-red-100 text-red-800',
  'completed': 'bg-emerald-100 text-emerald-800',
  'cancelled': 'bg-zinc-100 text-zinc-800',
  // Form/document status (lowercase)
  'draft': 'bg-zinc-100 text-zinc-800',
  'sent': 'bg-blue-100 text-blue-800',
  'viewed': 'bg-amber-100 text-amber-800',
  'signed': 'bg-emerald-100 text-emerald-800',
  'partially_signed': 'bg-amber-100 text-amber-800',
  'classified': 'bg-emerald-100 text-emerald-800',
  'unclassified': 'bg-amber-100 text-amber-800',
  'error': 'bg-red-100 text-red-800',
  'submitted': 'bg-blue-100 text-blue-800',
  'reviewed': 'bg-emerald-100 text-emerald-800',
  'converted': 'bg-emerald-100 text-emerald-800',
  'credited': 'bg-purple-100 text-purple-800',
  // Pending activation
  'awaiting_payment': 'bg-amber-100 text-amber-800',
  'payment_confirmed': 'bg-blue-100 text-blue-800',
  'activated': 'bg-emerald-100 text-emerald-800',
  // Deadline
  'Filed': 'bg-emerald-100 text-emerald-800',
}

// Service tracker slugs — URL path → DB service_type
export const SERVICE_TRACKER_SLUGS: Record<string, string> = {
  'formation': 'Company Formation',
  'onboarding': 'Client Onboarding',
  'tax-return': 'Tax Return',
  'itin': 'ITIN',
  'banking': 'Banking Fintech',
  'closure': 'Company Closure',
  'ein': 'EIN',
  'annual-report': 'State Annual Report',
  'ra-renewal': 'State RA Renewal',
  'cmra': 'CMRA Mailing Address',
  'billing-renewal': 'Billing Annual Renewal',
}

// Reverse: DB service_type → URL slug
export const SERVICE_TYPE_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SERVICE_TRACKER_SLUGS).map(([slug, type]) => [type, slug])
)

// Icons for each tracker type (lucide icon names)
export const TRACKER_ICONS: Record<string, string> = {
  'Company Formation': 'Building',
  'Client Onboarding': 'UserPlus',
  'Tax Return': 'FileText',
  'ITIN': 'CreditCard',
  'Banking Fintech': 'Landmark',
  'Company Closure': 'XCircle',
  'EIN': 'Hash',
  'State Annual Report': 'CalendarDays',
  'State RA Renewal': 'Shield',
  'CMRA Mailing Address': 'Mail',
  'Billing Annual Renewal': 'Receipt',
}
