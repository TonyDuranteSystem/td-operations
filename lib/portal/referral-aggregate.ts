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

/**
 * Map a referred LEAD's funnel status to a badge for the referrer's portal
 * Referral page, so the referrer sees where the person they referred is in the
 * journey (Call Done → Offer Sent → Paid …). A Lost lead keeps showing "Lost"
 * (per Antonio). Unknown/empty statuses fall back to the raw value in grey.
 * Pure — unit tested.
 */
/**
 * Returns a dictionary key (not pre-resolved text) so the caller can
 * translate it into any language via t(), not just en/it — the badge text
 * used to be baked in here as label_en/label_it, which meant it could never
 * pick up a third language (dev job 12cab351).
 *
 * `labelKey` is set only for a recognized status; an unrecognized one falls
 * back to `rawLabel` (the raw status string itself, or 'Pending' if even
 * that is empty) so an unmapped/future status still shows something
 * meaningful instead of being silently translated into the wrong word.
 */
export function leadStatusBadge(status: string | null | undefined): { labelKey: string | null; rawLabel: string; color: string } {
  const map: Record<string, { labelKey: string; color: string }> = {
    'New': { labelKey: 'leadStatus.new', color: 'bg-zinc-100 text-zinc-700' },
    'Call Scheduled': { labelKey: 'leadStatus.callScheduled', color: 'bg-blue-100 text-blue-800' },
    'Call Done': { labelKey: 'leadStatus.callDone', color: 'bg-indigo-100 text-indigo-800' },
    'Offer Sent': { labelKey: 'leadStatus.offerSent', color: 'bg-amber-100 text-amber-800' },
    'Negotiating': { labelKey: 'leadStatus.negotiating', color: 'bg-orange-100 text-orange-800' },
    'Paid': { labelKey: 'leadStatus.paid', color: 'bg-emerald-100 text-emerald-800' },
    'Converted': { labelKey: 'leadStatus.converted', color: 'bg-emerald-100 text-emerald-800' },
    'Lost': { labelKey: 'leadStatus.lost', color: 'bg-red-100 text-red-800' },
    'Suspended': { labelKey: 'leadStatus.suspended', color: 'bg-zinc-100 text-zinc-500' },
  }
  const key = (status || '').trim()
  const match = map[key]
  if (match) return { ...match, rawLabel: key }
  return { labelKey: null, rawLabel: key || 'Pending', color: 'bg-zinc-100 text-zinc-700' }
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
