/**
 * Portal Team Access — capability model.
 *
 * Capabilities are owner-chosen, per-section flags stored on
 * `portal_team_members.capabilities` (JSONB). They are enforced SERVER-SIDE and
 * are DEFAULT-DENY: a capability the owner did not explicitly grant (true) is
 * treated as denied.
 *
 * The owner decides what the team may do — that is the whole point, and each power is a tick. Only a short list is NEVER a tick
 * (TD keeps it hard-locked):
 *   - signing anything (the tax return, the operating agreement, leases, agreements — teammates may VIEW under `documents`)
 *   - generating documents, changing owners / members, managing the team itself, changing the owner's own login
 *
 * Adding a new grantable section later = add its key here + map it to routes.
 * No schema change required (the column is JSONB).
 *
 * Design: sysdoc 'portal-team-access-design'.
 */

export const TEAM_CAPABILITIES = [
  'documents',          // view documents incl. legal docs (OA/SS4/8832/MSA/lease) — VIEW only, never sign
  'invoices_billing',   // sales invoices + TD billing
  'chat',               // portal chat for the company
  'company_services',   // company profile + services/deadlines status
  'bank_applications',  // bank application flow
  'sales_customers',    // the client's own sales customers list (owner-grantable extra)
  'company_data_form',  // formation/onboarding company data form (owner-grantable extra)
  'announcements',      // portal announcements/notifications (owner-grantable extra)
  'payment_links',      // add / change / remove the company's invoice payment links (extra, needs invoices_billing)
  'invoice_history',    // see invoices and expenses saved BEFORE the person joined (extra, needs invoices_billing)
  'company_forms',      // fill in and send the company's tax questionnaire (the owner still signs the return)
  'request_services',   // ask for a new service (a request message in the company chat; needs chat)
  'answer_decisions',   // approve / choose when TD asks the company a question (needs documents, where the questions are shown)
] as const

export type TeamCapability = (typeof TEAM_CAPABILITIES)[number]

export type CapabilityFlags = Partial<Record<TeamCapability, boolean>>

const CAPABILITY_SET = new Set<string>(TEAM_CAPABILITIES)

/**
 * Sanitize arbitrary JSONB into a clean CapabilityFlags: only known keys,
 * only true values retained. Unknown keys and non-true values are dropped
 * (default-deny). Safe to call on untrusted DB content.
 */
export function normalizeCapabilities(input: unknown): CapabilityFlags {
  const out: CapabilityFlags = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (CAPABILITY_SET.has(key) && value === true) {
      out[key as TeamCapability] = true
    }
  }
  // Options that hang under Invoices & Billing mean nothing without it.
  if (!out.invoices_billing) {
    delete out.payment_links
    delete out.invoice_history
  }
  // A service request is a message in the company chat; a decision is shown on the documents / services page.
  if (!out.chat) delete out.request_services
  if (!out.documents) delete out.answer_decisions
  return out
}

/**
 * Default-deny capability check. Returns true ONLY when the flag is explicitly true.
 */
export function hasCapability(
  flags: CapabilityFlags | null | undefined,
  capability: TeamCapability,
): boolean {
  return !!flags && flags[capability] === true
}

/**
 * Map a sidebar nav key → the capability that gates it for a TEAMMATE.
 *   - a TeamCapability string → shown iff that capability is granted
 *   - 'always'                → always shown to teammates (home, guide)
 *   - null                    → never shown to teammates (owner-only / non-delegable)
 * Pure + client-safe (used by the sidebar).
 */
export function teammateNavCapability(navKey: string): TeamCapability | 'always' | null {
  switch (navKey) {
    case 'nav.overview':
    case 'nav.guide':
      return 'always'
    case 'nav.myCompany':
      return 'company_services'
    case 'nav.documents':
    case 'nav.generateDocuments':
      return 'documents'
    case 'nav.invoices':
    case 'nav.tdBilling':
      return 'invoices_billing'
    case 'nav.chat':
      return 'chat'
    case 'nav.myClients':
      return 'sales_customers'
    case 'nav.requestService':
      return 'request_services'
    // Owner-only / non-delegable: nav.team, nav.signDocuments,
    // nav.referrals, nav.profile, nav.offer, nav.wizard, partner items → hidden.
    default:
      return null
  }
}
