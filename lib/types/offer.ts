/**
 * Offer & Contract types — used by public pages and MCP tools
 * Column names match the database (English).
 */

// ─── JSONB Sub-types ────────────────────────────────────────

export interface OfferIssue {
  title: string
  description: string
}

export interface OfferImmediateAction {
  title: string
  text?: string
  description?: string
}

export interface OfferStrategyStep {
  step_number: number
  title: string
  description: string
}

export interface OfferService {
  name: string
  price: string
  price_label?: string
  description?: string
  recommended?: boolean
  includes?: string[]
  optional?: boolean        // If true, client can select/deselect on offer page
  pipeline_type?: string    // Maps to bundled_pipelines (e.g., "ITIN", "Tax Return")
  contract_type?: string    // Service-level contract type (e.g., "itin", "tax_return")
  service_context?: 'individual' | 'business' | 'ask'
  quantity?: number         // For multi-unit services (e.g., ITIN ×2); default 1
  unit_price?: string       // Per-unit price when quantity > 1
}

export interface CostSummaryItem {
  name: string
  price: string
}

export interface CostSummary {
  label: string
  items?: CostSummaryItem[]
  total_label?: string
  total?: string
  rate?: string
  installments?: string
}

export interface RecurringCost {
  label: string
  price: string
  currency?: string
}

export interface FutureDevelopment {
  text: string
}

export interface NextStep {
  step_number: number
  title: string
  description: string
}

export interface PaymentLink {
  url: string
  label: string
  amount: string
}

export interface BankDetails {
  beneficiary?: string
  iban?: string
  bic?: string
  bank_name?: string
  bank_address?: string
  account_number?: string
  routing_number?: string
  amount?: string
  reference?: string
}

// ─── Main Offer Interface ───────────────────────────────────

export interface Offer {
  id: string
  token: string
  client_name: string
  client_email?: string
  offer_date: string
  language: 'en' | 'it'
  intro_en?: string
  intro_it?: string
  issues?: OfferIssue[]
  immediate_actions?: OfferImmediateAction[]
  strategy?: OfferStrategyStep[]
  services?: OfferService[]
  additional_services?: OfferService[]
  cost_summary?: CostSummary[]
  recurring_costs?: RecurringCost[]
  future_developments?: FutureDevelopment[]
  next_steps?: NextStep[]
  status: 'draft' | 'sent' | 'published' | 'viewed' | 'signed' | 'completed' | 'expired'
  expires_at?: string
  viewed_at?: string
  view_count: number
  created_at: string
  updated_at: string
  payment_links?: PaymentLink[]
  payment_type?: 'checkout' | 'bank_transfer' | 'none'
  bank_details?: BankDetails
  effective_date?: string
  // Linking
  lead_id?: string
  deal_id?: string
  // Referrer tracking
  referrer_name?: string
  referrer_email?: string
  referrer_type?: 'client' | 'partner'
  referrer_account_id?: string
  referrer_commission_type?: 'percentage' | 'price_difference' | 'credit_note'
  referrer_commission_pct?: number
  referrer_agreed_price?: number
  referrer_notes?: string
  // Link protection
  access_code?: string
  // Currency
  currency?: string
  installment_currency?: string
  // Contract type
  contract_type?: 'formation' | 'onboarding' | 'tax_return' | 'itin' | 'renewal'
  // Pipelines to create when client pays (automation)
  bundled_pipelines?: string[]
  // Client selections (set when client signs, based on optional services chosen)
  selected_services?: string[]
  account_id?: string
  // Entity type (SMLLC / MMLLC / C-Corp). Added 2026-04-22 as part of the
  // MMLLC build. Uses the same company_type enum as accounts.entity_type so
  // values round-trip without translation. Older offers created before the
  // column existed may have this field unset — consumers must fall back to
  // legacy derivation (e.g., service-name string match).
  entity_type?: 'Single Member LLC' | 'Multi Member LLC' | 'C-Corp Elected'
}

// ─── Contract Interface ─────────────────────────────────────

export interface Contract {
  id: string
  offer_token: string
  client_name: string
  client_email?: string
  client_phone?: string
  client_address?: string
  client_city?: string
  client_state?: string
  client_zip?: string
  client_country?: string
  client_nationality?: string
  client_passport?: string
  client_passport_exp?: string
  llc_type?: string
  annual_fee?: string
  contract_year?: string
  installments?: string
  signed_at?: string
  signed_ip?: string
  pdf_path?: string
  status?: 'pending' | 'signed' | 'completed'
  wire_receipt_path?: string
  selected_services?: string[]  // Services client chose at signing time
  payment_verified?: boolean
  created_at: string
  updated_at: string
}
