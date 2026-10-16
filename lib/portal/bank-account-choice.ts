/**
 * Which bank account an invoice should show by default (dev job 1a23f5f1, 10 Oct 2026 QA).
 * A euro invoice used to pick the account flagged "show on invoice" even when that account was in dollars, so a
 * European customer could be shown US wiring details. Pure, so the rule is tested without a screen.
 */

export interface BankChoice {
  id: string
  currency: string
  show_on_invoice?: boolean
}

/** Same currency first (the one flagged "show on invoice" before the others), then the flagged one, then the first. */
export function pickBankAccountId(accounts: BankChoice[], currency: string): string | null {
  if (accounts.length === 0) return null
  const sameCurrency = accounts.filter(a => a.currency === currency)
  const pool = sameCurrency.length > 0 ? sameCurrency : accounts
  return (pool.find(a => a.show_on_invoice) ?? pool[0]).id
}

export type BankCurrencyNote = 'none' | 'mismatch' | 'no_match'

/**
 * 'mismatch' = the chosen account is in another currency but the company has one in the invoice's currency.
 * 'no_match' = the company has no account in the invoice's currency at all.
 * 'none' = nothing to say (no account chosen, or the currencies agree).
 */
export function bankCurrencyNote(accounts: BankChoice[], selectedId: string | null | undefined, currency: string): BankCurrencyNote {
  if (!selectedId) return 'none'
  const chosen = accounts.find(a => a.id === selectedId)
  if (!chosen || chosen.currency === currency) return 'none'
  return accounts.some(a => a.currency === currency) ? 'mismatch' : 'no_match'
}
