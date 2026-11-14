/**
 * Who a company's "Main contact" is, and how many CURRENT members it has, for the Accounts list. Pure.
 */

export interface AccountContactLink {
  account_id: string
  is_primary: boolean | null
  ended_at: string | null
  contact: { full_name: string; email: string | null } | null
}

/**
 * One main contact per company: the primary contact whose link has not ended, else any contact whose link has not ended, else none.
 * (The old list took whichever link the database returned first, which could be a former member.)
 */
export function pickMainContacts(links: AccountContactLink[]): Record<string, { name: string; email: string | null }> {
  const out: Record<string, { name: string; email: string | null }> = {}
  const rank = (l: AccountContactLink) => (l.is_primary ? 0 : 1)
  const live = links.filter((l) => l.contact && !l.ended_at).sort((a, b) => rank(a) - rank(b))
  for (const l of live) {
    if (l.contact && !out[l.account_id]) out[l.account_id] = { name: l.contact.full_name, email: l.contact.email }
  }
  return out
}

export interface MemberRow {
  account_id: string
  end_date: string | null
}

/** Members per company whose membership has not ended (no end date, or an end date still ahead). `today` is YYYY-MM-DD. */
export function currentMemberCounts(rows: MemberRow[], today: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (r.end_date && r.end_date <= today) continue
    out[r.account_id] = (out[r.account_id] ?? 0) + 1
  }
  return out
}
