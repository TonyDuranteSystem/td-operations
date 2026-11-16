/**
 * What the Contacts and Accounts list search matches — the SAME things the search dropdown shows (GET /api/search), so the list under
 * the box and the dropdown agree about who matches while you type (Antonio 2026-11-16: "the list must change dynamically while the
 * dropdown shows the list of the letters written").
 *
 * Pure and client-safe. A match is a case-insensitive substring (no wildcard characters: what you type is what is looked for).
 *  - a person: their name, email or phone, OR the name of a company they are linked to;
 *  - a company: its name, OR the name of a person linked to it.
 * An empty search matches everything.
 */

function has(text: string | null | undefined, needle: string): boolean {
  return !!text && text.toLowerCase().includes(needle)
}

function needleOf(query: string): string {
  return query.trim().toLowerCase()
}

export function contactMatchesSearch(
  query: string,
  person: { full_name: string | null; email: string | null; phone: string | null },
  companyNames: string[],
): boolean {
  const n = needleOf(query)
  if (!n) return true
  return has(person.full_name, n) || has(person.email, n) || has(person.phone, n) || companyNames.some((c) => has(c, n))
}

export function accountMatchesSearch(query: string, account: { company_name: string | null }, personNames: string[]): boolean {
  const n = needleOf(query)
  if (!n) return true
  return has(account.company_name, n) || personNames.some((p) => has(p, n))
}
