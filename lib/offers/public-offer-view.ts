/**
 * What the PUBLIC offer pages may see of an offer row (N0, dev job f907220c).
 *
 * Until N0 the offer pages read the whole row straight from the database with the
 * public key — access code, referral commissions, partner payout terms, internal
 * notes, CRM links — for anyone who could guess the token (tokens are the client's
 * name + the year). The pages now get the row from a server route, and this is the
 * one filter every such route passes it through.
 *
 * DENY-LIST, deliberately: every column the pages render is client-facing content
 * (services, prices, bank details, texts), and a new client-facing column should
 * reach the page without a code change. What must NEVER reach a browser is listed
 * here and pinned by a unit test that also fails when a column with an internal-
 * looking name (referrer_*, partner_*, commission*, admin*, *_id links) appears
 * without being classified.
 */

export const OFFER_PRIVATE_FIELDS = [
  'access_code',
  'lead_id',
  'deal_id',
  'account_id',
  'contact_id',
  'admin_notes',
  'referrer_name',
  'referrer_email',
  'referrer_type',
  'referrer_account_id',
  'referrer_contact_id',
  'referrer_commission_type',
  'referrer_commission_pct',
  'referrer_agreed_price',
  'referrer_notes',
  'partner_id',
  'partner_invoice_target',
  'partner_agreed_price',
  'partner_payout_model',
  'partner_payout_rate',
  'partner_renewal_payout',
  'credit_payment_id',
  'commission_released_at',
  'bill_to',
  'superseded_by',
  'bundled_pipeline_entry_ids',
] as const

const PRIVATE = new Set<string>(OFFER_PRIVATE_FIELDS)

/** The row with every private column removed. Never mutates the input. */
export function toPublicOfferView<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!PRIVATE.has(k)) out[k] = v
  }
  return out
}

/** Columns an annual renewal agreement may show on the public contract page. */
export const RENEWAL_PUBLIC_FIELDS = [
  'token',
  'client_name',
  'client_email',
  'language',
  'effective_date',
  'services',
  'cost_summary',
  'payment_type',
  'status',
  'agreement_year',
] as const

/**
 * A renewal agreement shaped the way the contract page has always consumed it
 * (it used to build exactly this object in the browser from the same columns).
 */
export function toPublicRenewalView(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of RENEWAL_PUBLIC_FIELDS) out[k] = row[k] ?? null
  return {
    ...out,
    contract_type: 'renewal',
    installment_currency: 'USD',
    currency: 'USD',
    cost_summary: (row.cost_summary as unknown[]) || [],
    services: (row.services as unknown[]) || [],
  }
}
