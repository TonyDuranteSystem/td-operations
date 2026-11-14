/**
 * The money columns on the Accounts and Contacts lists: which amounts can be edited there, when they are locked, how a
 * typed value is read, and how "Per year" is added up.
 *
 * Pure and client-safe. The SERVER re-runs `prepareAmountEdit` on every save (the greyed lock on screen is a courtesy; this
 * is the rule).
 */

import { parseAmountInput, formatNumber } from '@/lib/signed-contracts/amount-input'

/** Companies in these statuses show their amounts greyed and locked in the lists (decided by Antonio, 14 Nov 2026). Suspended and
 *  Pending Formation are NOT locked. */
export const LOCKED_ACCOUNT_STATUSES = ['Closed', 'Cancelled', 'Offboarding'] as const

export function isAmountLocked(status: string | null | undefined): boolean {
  return !!status && (LOCKED_ACCOUNT_STATUSES as readonly string[]).includes(status)
}

/** The company fields a list cell may save. Currency is NOT editable from a list (use the Account page). */
export const LIST_AMOUNT_FIELDS = ['installment_1_amount', 'installment_2_amount', 'setup_fee_amount'] as const
export type ListAmountField = (typeof LIST_AMOUNT_FIELDS)[number]

export function isListAmountField(field: string): field is ListAmountField {
  return (LIST_AMOUNT_FIELDS as readonly string[]).includes(field)
}

// The optional `error?: undefined` / `value?: undefined` members let callers read `.error` / `.value` WITHOUT narrowing: this project
// compiles with strict off, where `if (!r.ok)` does not narrow a boolean-tagged union (the CI build failed on exactly that).
export type PreparedAmount =
  | { ok: true; /** the text to store ('' clears the amount) */ value: string; /** the number, or null when cleared */ amount: number | null; error?: undefined }
  | { ok: false; error: string; value?: undefined; amount?: undefined }

/**
 * Check one list edit before anything is written.
 * - only the three amount fields;
 * - a Closed / Cancelled / Offboarding company is refused;
 * - an empty box clears the amount (the same as the Account page);
 * - "1,250" / "1.250" / "$ 1 250,00" are read like the signed-contracts card reads them;
 * - zero is refused (leave the box empty to clear instead of saving a $0 installment).
 */
export function prepareAmountEdit(args: { field: string; raw: string; status: string | null | undefined }): PreparedAmount {
  if (!isListAmountField(args.field)) return { ok: false, error: 'This field cannot be edited from a list.' }
  if (isAmountLocked(args.status)) {
    return { ok: false, error: `This company is ${args.status}, so its amounts are locked here.` }
  }
  if (typeof args.raw !== 'string' || args.raw.trim() === '') return { ok: true, value: '', amount: null }
  const parsed = parseAmountInput(args.raw)
  if (parsed.kind === 'refused') return { ok: false, error: parsed.error }
  if (parsed.value <= 0) return { ok: false, error: 'Type an amount above 0, or leave the box empty to clear it.' }
  return { ok: true, value: String(parsed.value), amount: parsed.value }
}

export function currencySymbol(currency: string | null | undefined): string {
  if (currency === 'EUR') return '€'
  if (currency === 'USD' || !currency) return '$'
  return ''
}

/** 1250, 'USD' -> "$1,250"; an unknown currency shows the bare number. */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  return `${currencySymbol(currency)}${formatNumber(amount)}`
}

export interface MoneyPart {
  amount: number | null
  currency: string | null
}

/** What the "Per year" cell shows. */
export type PerYear =
  | { kind: 'none' }
  | { kind: 'one'; amount: number; currency: string }
  | { kind: 'split'; parts: { amount: number; currency: string }[] }

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 1st Inst + 2nd Inst, added up on screen — never typed and never read from a contract. If the two are in DIFFERENT currencies
 * they are not added: each is shown with its own symbol. A missing currency counts as USD (the Account page does the same).
 */
export function perYearTotal(first: MoneyPart, second: MoneyPart): PerYear {
  const parts: { amount: number; currency: string }[] = []
  for (const p of [first, second]) {
    if (p.amount != null && Number.isFinite(p.amount)) parts.push({ amount: p.amount, currency: p.currency || 'USD' })
  }
  if (parts.length === 0) return { kind: 'none' }
  const currencies = Array.from(new Set(parts.map((p) => p.currency)))
  if (currencies.length === 1) {
    return { kind: 'one', amount: round2(parts.reduce((s, p) => s + p.amount, 0)), currency: currencies[0] }
  }
  return { kind: 'split', parts }
}

/** The text of a Per year result, for display and tests. */
export function perYearLabel(total: PerYear): string {
  if (total.kind === 'none') return '—'
  if (total.kind === 'one') return formatMoney(total.amount, total.currency)
  return total.parts.map((p) => formatMoney(p.amount, p.currency)).join(' + ')
}
