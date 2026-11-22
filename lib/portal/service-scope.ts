/**
 * The SERVICE-SCOPED portal login (Antonio, 22 Nov 2026): a client who buys one service on its own (a "One-Time" company) gets a portal login that shows
 * ONLY that service and what relates to it — the overview with the company and personal information, their own documents, the documents to sign,
 * the chat, their invoice, the guide and their profile. Buying another service adds that service's own sections to the same login; buying annual
 * management (a "Client" company) lifts the limit.
 *
 * ONE rule, read by every place that decides what a login can open: the website's side menu and the iPhone app's menu (both through
 * lib/portal/nav-rules.ts) and the guards on the pages themselves (lib/portal/service-scope-server.ts) — so a page that is hidden from the menu is also
 * refused when its address is typed. The sections a service ADDS are catalog data (`metadata.portal_nav_keys` on the service's catalog row), not code.
 *
 * Pure: no database, client-safe. See docs/systems/portal.md.
 */

/** The company label that makes a login service-scoped. The tier is not a fifth level (R102): this is a different question — what was bought. */
export const SERVICE_SCOPED_ACCOUNT_TYPE = 'One-Time'

/**
 * Menu entries a service-scoped login never has, unless a service it bought adds one back (catalog `portal_nav_keys`).
 * Referrals / Generate Documents / Team / My Company / Request a Service are not part of a single bought service; Bank Applications belongs to
 * the banking service only; Customers is the client's own sales tool.
 */
export const SERVICE_SCOPED_HIDDEN_NAV_KEYS: readonly string[] = [
  'nav.referrals',
  'nav.requestService',
  'nav.generateDocuments',
  'nav.team',
  'nav.myCompany',
  'nav.bankApplications',
  'nav.myClients',
]

/** The portal page each hidden entry guards (the pages call the server guard with these keys, so the menu and the page can never disagree). */
export const SERVICE_SCOPED_PAGE_KEYS = {
  referrals: 'nav.referrals',
  requestService: 'nav.requestService',
  generateDocuments: 'nav.generateDocuments',
  team: 'nav.team',
  company: 'nav.myCompany',
  banks: 'nav.bankApplications',
  customers: 'nav.myClients',
} as const

export interface ServiceScopeInput {
  /** the selected company's label ("One-Time" or "Client" …) */
  accountType?: string | null
  /** the person has at least one company */
  hasCompany: boolean
  /** the portal level: with NO company, only a person at the active level (a one-time individual, e.g. an ITIN) is limited — a lead or a client being set up is not */
  portalTier?: string | null
  portalRole?: string | null
  /** a team member follows the capabilities the owner granted, never this rule */
  isTeammate?: boolean
}

/**
 * Is this login limited to the service(s) it bought? Pure. A partner and a team member follow their own rules.
 *  - with a company: the company is labeled "One-Time" (annual management, "Client", lifts the limit);
 *  - with NO company: an individual at the active level (a personal service such as an ITIN). A lead, or a person being set up, is not limited.
 */
export function isServiceScopedLogin(p: ServiceScopeInput): boolean {
  if (p.isTeammate) return false
  if (p.portalRole === 'partner') return false
  if (p.hasCompany) return p.accountType === SERVICE_SCOPED_ACCOUNT_TYPE
  return p.portalTier === 'active'
}

/** Is this menu entry hidden from a service-scoped login? `unlocked` = the entries the bought services add back. Pure. */
export function scopedNavKeyHidden(navKey: string, unlocked?: readonly string[] | null): boolean {
  if (!SERVICE_SCOPED_HIDDEN_NAV_KEYS.includes(navKey)) return false
  return !(unlocked ?? []).includes(navKey)
}

/** The entries a service adds back, read from its catalog row's `metadata.portal_nav_keys` (anything that is not a known hidden entry is ignored). Pure. */
export function portalNavKeysOf(metadata: unknown): string[] {
  const raw = (metadata as { portal_nav_keys?: unknown } | null | undefined)?.portal_nav_keys
  if (!Array.isArray(raw)) return []
  return raw.filter((k): k is string => typeof k === 'string' && SERVICE_SCOPED_HIDDEN_NAV_KEYS.includes(k))
}
