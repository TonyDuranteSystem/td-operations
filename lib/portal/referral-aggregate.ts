/**
 * Pure helpers for the portal Referral page.
 *
 * A contact sees referrals they made personally (referrer_contact_id) PLUS
 * referrals made by a company where they are the **primary** contact. "Primary"
 * is resolved leak-safely:
 *   1. an explicit `is_primary = true` flag on the membership wins;
 *   2. otherwise the **sole member** of a single-member company is primary;
 *   3. otherwise (multi-member, no flag) the company has NO primary — so
 *      co-members never see each other's company referral earnings.
 *
 * This exists because the `is_primary` / `portal_admin_contact_id` columns are
 * largely unpopulated in production (the sole member of a single-member LLC is
 * often tagged role='Member', is_primary=false), so a flag-only rule would
 * silently show nothing.
 */

export interface AccountMembership {
  account_id: string
  contact_id: string
  is_primary: boolean | null
}

/**
 * Return the subset of `myAccountIds` where `contactId` is the primary contact,
 * given the full membership list for those accounts.
 */
export function computePrimaryAccountIds(
  contactId: string,
  myAccountIds: string[],
  allMemberships: AccountMembership[],
): string[] {
  const byAccount = new Map<string, AccountMembership[]>()
  for (const m of allMemberships) {
    const list = byAccount.get(m.account_id)
    if (list) list.push(m)
    else byAccount.set(m.account_id, [m])
  }

  const primary: string[] = []
  for (const accountId of myAccountIds) {
    const members = byAccount.get(accountId) ?? []
    const flagged = members.filter(m => m.is_primary === true)

    if (flagged.length > 0) {
      // Explicit primary flag wins — I'm primary only if I'm one of the flagged.
      if (flagged.some(m => m.contact_id === contactId)) primary.push(accountId)
      continue
    }

    // No explicit flag → the sole member is the primary.
    const distinctContacts = new Set(members.map(m => m.contact_id))
    if (distinctContacts.size === 1 && distinctContacts.has(contactId)) {
      primary.push(accountId)
    }
  }
  return primary
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }

export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return '€'
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `
}

/** Format an amount with its currency symbol, e.g. (300, 'USD') → "$300". */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  return `${currencySymbol(currency)}${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 0 })}`
}

export interface EarnedRow {
  credited_amount: number | null
  paid_amount: number | null
  commission_currency: string | null
}

/**
 * Sum credited + paid grouped by currency. Only currencies with a non-zero
 * total are returned. USD and EUR rewards coexist (the reward basis is the EUR
 * setup fee but the credit is issued in USD), so they must never be summed into
 * a single number under one symbol.
 */
export function sumEarnedByCurrency(rows: EarnedRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    const amt = (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0)
    if (amt === 0) continue
    const cur = (r.commission_currency || 'EUR').toUpperCase()
    out[cur] = (out[cur] ?? 0) + amt
  }
  return out
}

/**
 * Render the earned total as a per-currency string, e.g. "$300 · €250".
 * Returns "€0" when nothing has been earned.
 */
export function formatEarnedSummary(byCurrency: Record<string, number>): string {
  const parts = Object.entries(byCurrency)
    .filter(([, amt]) => amt !== 0)
    .map(([cur, amt]) => formatMoney(amt, cur))
  return parts.length ? parts.join(' · ') : '€0'
}
