/**
 * E-Sign signer picker — one row per (person × company) plus a personal row.
 *
 * Why this exists: the picker used to return ONE row per contact, enriched with
 * the contact's "primary else first" linked account. For a person with several
 * companies and no primary flag (e.g. an owner of three LLCs) that was an
 * arbitrary company, and the editor silently filed the envelope under it — a
 * Whalecot tax return was filed under AI Venture Labs and the client was alerted
 * in the wrong company's portal. Now every company a person is linked to is its
 * own explicit row, and staff pick the exact one. No cap on rows per person.
 *
 * Pure — no I/O — so the route stays thin and this is unit-tested.
 */

export type SignerRowContact = { id: string; full_name: string | null; email: string | null }
export type SignerRowLink = { contact_id: string; account_id: string }

export type SignerPickRow = {
  /** Stable React key: contact + company (or "personal"). */
  key: string
  contact_id: string
  full_name: string
  email: string | null
  /** null = the personal row (not filed under any company). */
  account_id: string | null
  company_name: string | null
  /** True when this row's company matched the search term by company name. */
  company_match: boolean
}

export function buildSignerRows(input: {
  contacts: SignerRowContact[]
  links: SignerRowLink[]
  accountNames: Map<string, string | null>
  /** Accounts whose company name matched the search term. */
  matchedAccountIds: Set<string>
}): SignerPickRow[] {
  const { contacts, links, accountNames, matchedAccountIds } = input

  const accountsByContact = new Map<string, string[]>()
  for (const l of links) {
    const list = accountsByContact.get(l.contact_id) ?? []
    if (!list.includes(l.account_id)) list.push(l.account_id)
    accountsByContact.set(l.contact_id, list)
  }

  const seen = new Set<string>()
  const rows: SignerPickRow[] = []
  for (const c of contacts) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    const base = { contact_id: c.id, full_name: c.full_name ?? "", email: c.email ?? null }
    for (const accountId of accountsByContact.get(c.id) ?? []) {
      rows.push({
        ...base,
        key: `${c.id}:${accountId}`,
        account_id: accountId,
        company_name: accountNames.get(accountId) ?? null,
        company_match: matchedAccountIds.has(accountId),
      })
    }
    // The person on their own — always offered, so staff can see and pick it
    // explicitly (the editor warns that it will not be filed under a company).
    rows.push({ ...base, key: `${c.id}:personal`, account_id: null, company_name: null, company_match: false })
  }

  // Company-name matches first (typing "whal" puts the Whalecot row on top), then
  // by person, then company rows before the personal row, then company name.
  rows.sort((a, b) => {
    if (a.company_match !== b.company_match) return a.company_match ? -1 : 1
    const byName = a.full_name.localeCompare(b.full_name)
    if (byName !== 0) return byName
    if ((a.account_id === null) !== (b.account_id === null)) return a.account_id === null ? 1 : -1
    return (a.company_name ?? "").localeCompare(b.company_name ?? "")
  })
  return rows
}
