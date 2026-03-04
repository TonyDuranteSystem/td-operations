// Enum values from CRM-Data-Schema.md — Section 2

export const ACCOUNT_STATUS = [
  'Active', 'Pending Formation', 'Delinquent', 'Suspended', 'Cancelled', 'Closed',
] as const

export const COMPANY_TYPE = [
  'Single Member LLC', 'Multi Member LLC', 'C-Corp Elected',
] as const

export const SERVICE_TYPE = [
  'Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal',
  'State Annual Report', 'EIN Application', 'CMRA Mailing Address', 'ITIN',
  'Banking Fintech', 'Banking Physical', 'Shipping', 'Public Notary',
  'Company Closure', 'Offboarding', 'Annual Renewal', 'Support',
] as const

export const SERVICE_STATUS = [
  'Not Started', 'In Progress', 'Waiting Client', 'Waiting Third Party', 'Completed', 'Cancelled',
] as const

export const DEAL_STAGE = [
  'Initial Consultation', 'Offer Sent', 'Negotiation', 'Agreement Signed', 'Closed Won', 'Closed Lost',
] as const

export const LEAD_STATUS = [
  'New', 'Call Scheduled', 'Call Done', 'Offer Sent', 'Negotiating', 'Converted', 'Lost', 'Suspended',
] as const

export const PAYMENT_STATUS = [
  'Pending', 'Paid', 'Overdue', 'Delinquent', 'Waived', 'Refunded',
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
  'Payment Pending', 'Paid - Need Deal', 'Deal Created - Need Link',
  'Link Sent - Awaiting Data', 'Data Received', 'Sent to India',
  'Extension Filed', 'TR Completed - Awaiting Signature', 'TR Filed',
] as const

export const CONVERSATION_CHANNEL = [
  'WhatsApp', 'Telegram', 'Email', 'Phone', 'Portal', 'In-Person',
] as const

export const CONVERSATION_STATUS = [
  'New', 'Proposed', 'Approved', 'Sent', 'Archived',
] as const

export const OFFER_STATUS = [
  'Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Negotiating',
] as const

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

// Badge color mappings
export const STATUS_COLORS: Record<string, string> = {
  // Account
  'Active': 'bg-emerald-100 text-emerald-800',
  'Pending Formation': 'bg-amber-100 text-amber-800',
  'Delinquent': 'bg-red-100 text-red-800',
  'Suspended': 'bg-orange-100 text-orange-800',
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
}
