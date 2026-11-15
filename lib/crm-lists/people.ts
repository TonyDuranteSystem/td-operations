/**
 * Who a company's "Main contact" is, and how many CURRENT members it has, for the Accounts list. Pure.
 */

export interface AccountContactLink {
  account_id: string
  is_primary: boolean | null
  ended_at: string | null
  contact: { id?: string; full_name: string; email: string | null; phone?: string | null; language?: string | null; portal_tier?: string | null } | null
}

/** A company's main contact: the name and email the list shows, plus what the hover card shows. */
export interface MainContact {
  id: string | null
  name: string
  email: string | null
  phone: string | null
  language: string | null
  portal_tier: string | null
}

/**
 * One main contact per company: the primary contact whose link has not ended, else any contact whose link has not ended, else none.
 * (The old list took whichever link the database returned first, which could be a former member.)
 */
export function pickMainContacts(links: AccountContactLink[]): Record<string, MainContact> {
  const out: Record<string, MainContact> = {}
  const rank = (l: AccountContactLink) => (l.is_primary ? 0 : 1)
  const live = links.filter((l) => l.contact && !l.ended_at).sort((a, b) => rank(a) - rank(b))
  for (const l of live) {
    if (l.contact && !out[l.account_id]) {
      out[l.account_id] = {
        id: l.contact.id ?? null,
        name: l.contact.full_name,
        email: l.contact.email,
        phone: l.contact.phone ?? null,
        language: l.contact.language ?? null,
        portal_tier: l.contact.portal_tier ?? null,
      }
    }
  }
  return out
}

export interface PersonCompanyRow {
  contact_id: string
  account: { company_name: string; status: string | null } | null
}

/** Each person's companies (name + status, by name), for the contact hover card. The same links the Contacts list shows. */
export function companiesByPerson(rows: PersonCompanyRow[]): Record<string, { company_name: string; status: string | null }[]> {
  const out: Record<string, { company_name: string; status: string | null }[]> = {}
  for (const r of rows) {
    if (!r.account) continue
    const list = (out[r.contact_id] ??= [])
    if (!list.some((c) => c.company_name === r.account!.company_name)) list.push({ company_name: r.account.company_name, status: r.account.status })
  }
  for (const id of Object.keys(out)) out[id].sort((a, b) => a.company_name.localeCompare(b.company_name))
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
