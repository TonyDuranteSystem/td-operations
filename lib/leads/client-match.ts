// "Already a client" badge for the Leads list (dev job 6fc63c52, step 2).
//
// A live, exact-email check against the contacts that belong to at least one
// company. It only drives a badge — it never moves a lead between tabs and
// never writes anything, so a wrong match costs a label, not a record.

/** Lowercased, trimmed email, or '' when there is nothing usable. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/** The set of emails (normalized) held by contacts linked to a company. */
export function buildClientEmailSet(contacts: { email: string | null }[]): Set<string> {
  const set = new Set<string>()
  for (const c of contacts) {
    const e = normalizeEmail(c.email)
    if (e) set.add(e)
  }
  return set
}

export function isLiveClient(email: string | null | undefined, clientEmails: Set<string>): boolean {
  const e = normalizeEmail(email)
  return e !== '' && clientEmails.has(e)
}
