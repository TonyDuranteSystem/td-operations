/**
 * Derive the canonical per-client memory scope ("account:<id>" | "contact:<id>")
 * from the dashboard route the sidebar assistant is open on, so the worker's brain
 * is scoped to the client whose page the staff member is viewing (Business Brain
 * D2 / P5). Read from the LIVE pathname on each send — never a cached value — so
 * navigating from client A's page to client B's can't mis-scope a save or recall.
 * Returns undefined off a client page (general / global context).
 */
export function clientKeyFromPath(pathname: string | null | undefined): string | undefined {
  if (!pathname) return undefined
  const acct = pathname.match(/\/accounts\/([0-9a-fA-F-]{10,})/)
  if (acct) return `account:${acct[1]}`
  const contact = pathname.match(/\/contacts\/([0-9a-fA-F-]{10,})/)
  if (contact) return `contact:${contact[1]}`
  return undefined
}

/**
 * Server-side validation of the client scope the panel sends. Only a well-formed
 * "account:<id>" | "contact:<id>" is accepted — anything else (or absent) means no
 * scope (general/global). The panel derives it from the URL, so it is never trusted
 * without this shape check.
 */
export function parseSidebarClientKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return /^(account|contact):[0-9a-fA-F-]{10,}$/.test(v) ? v : null
}
