/**
 * Does the company's own installment amount (`accounts.installment_1_amount` / `installment_2_amount`, what the CRM shows and
 * what the June invoice is raised from) agree with what the client SIGNED (`contracts.installments`)? (Antonio, 2026-11-15,
 * dev job fba44df5: "the system should tell me the mismatch".)
 *
 * Pure (no database, no React), so every rule here is unit-tested. The loader reads the company rows; the card only draws the
 * result. Nothing is ever fixed by this: it only says what it found, and says "not compared" when it did not compare, so a
 * missing note can never be mistaken for "matches".
 *
 * Only formation / onboarding contracts are compared: they are the ones whose amounts live on the contract itself. Renewal
 * agreements keep their amounts as text on the agreement and are not compared here.
 */
import { formatSavedNumber } from './amount-input'

/** The company's installment columns, as the loader selects them. */
export interface CompanyAmountsRow {
  id: string
  installment_1_amount: unknown
  installment_1_currency: string | null
  installment_2_amount: unknown
  installment_2_currency: string | null
}

/** What the loader found when it looked the companies up. `failed` = the read itself failed (never "no company"). */
export type CompanyLookup = { kind: 'ok'; byId: Map<string, CompanyAmountsRow> } | { kind: 'failed' }

export type CompanyCheck =
  /** the company's two amounts are the same as the contract's */
  | { state: 'match' }
  /** they differ: `january` / `june` are the COMPANY's saved amounts, as text with their currency symbol */
  | { state: 'differ'; january: string; june: string }
  /** the company has no installment amounts saved at all */
  | { state: 'company_empty' }
  /** the offer is not filed on a company (or that company is not found): there is nothing to compare with */
  | { state: 'no_company' }
  /** the contract's own amounts cannot be read as two numbers: nothing to compare */
  | { state: 'unreadable' }
  /** the company lookup failed: nothing is claimed either way */
  | { state: 'lookup_failed' }

const symbolOf = (currency: string | null | undefined): string => (currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '')

/** A number column read back as a finite number, or null (empty, text that is not a number, NaN). */
function numberOf(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.005

export function checkContractAgainstCompany(input: {
  /** the contract's saved January / June amounts (null = not saved) and whether they could not be read at all */
  january: number | null
  june: number | null
  unreadable: boolean
  /** "$" / "€" when the offer says which; '' = unknown (then currency is not compared) */
  symbol: string
  /** the company the offer is filed on */
  accountId: string | null
  lookup: CompanyLookup
}): CompanyCheck {
  if (input.unreadable || input.january == null || input.june == null) return { state: 'unreadable' }
  if (!input.accountId) return { state: 'no_company' }
  if (input.lookup.kind === 'failed') return { state: 'lookup_failed' }
  const company = input.lookup.byId.get(input.accountId)
  if (!company) return { state: 'no_company' }

  const c1 = numberOf(company.installment_1_amount)
  const c2 = numberOf(company.installment_2_amount)
  if (c1 == null || c2 == null) return { state: 'company_empty' }

  const s1 = symbolOf(company.installment_1_currency)
  const s2 = symbolOf(company.installment_2_currency)
  // a currency counts only when BOTH sides say which: an unknown one is never guessed
  const currencyDiffers = (company: string) => input.symbol !== '' && company !== '' && company !== input.symbol
  const agrees = same(input.january, c1) && same(input.june, c2) && !currencyDiffers(s1) && !currencyDiffers(s2)
  if (agrees) return { state: 'match' }
  return { state: 'differ', january: `${s1}${formatSavedNumber(c1)}`, june: `${s2}${formatSavedNumber(c2)}` }
}
