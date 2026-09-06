/**
 * Capture -> Portal Chat destination search (Phase 2).
 *
 * Returns, for a staff-typed name/company search, every real send target: a
 * matched contact's own personal conversation, plus one candidate per company
 * they're actually linked to (via account_contacts) -- mirrors the "all real
 * combinations" shape Antonio required for the Phase 1 pickers, but sourced
 * from every contact (not just ones with an existing conversation already --
 * GET /api/portal/chat/threads was considered and rejected as the source for
 * exactly that reason).
 *
 * Two filters neither Phase-1 picker needed, both found by council review of
 * the Phase 2 plan (2026-09-04):
 *  - company candidates are dropped for a Closed/Cancelled/Delinquent/
 *    Pending-Formation account -- the client's own account list already hides
 *    those (lib/portal/queries.ts's Active/Suspended filter), so a send there
 *    would succeed with no error while being permanently invisible.
 *  - both kinds are dropped for a contact who was never actually sent a
 *    portal invite (portal_email_sent_at IS NULL) -- otherwise a lead/referral
 *    contact who matches by name could get a real "you have a new message"
 *    email pointing at a portal login they don't have.
 *
 * Every candidate carries the contact's email as a distinguishing detail
 * (two real clients can share a name) and keeps its own explicit contactId --
 * never collapsed into a single opaque id -- so a company reached via two
 * different matched contacts renders as two distinct, correctly labelled
 * rows instead of visually identical duplicates.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface PortalDestinationCandidate {
  contactId: string
  contactName: string
  contactEmail: string
  kind: "personal" | "company"
  accountId: string | null
  companyName: string | null
}

const MAX_CANDIDATES = 20

/** Escape %, _, and the .or() filter's own syntax characters (, ( )) — same
 * concern as lib/inbox/recipient-search.ts's escapeIlikeTerm, kept local
 * since this module's match shape (contact + company, not email) differs. */
function escapeIlikeTerm(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/[,()*]/g, " ").replace(/[%_]/g, "\\$&").trim()
}

export interface ContactRow {
  id: string
  full_name: string | null
  email: string | null
  portal_email_sent_at: string | null
  account_contacts: { account_id: string; accounts: { id: string; company_name: string; status: string } | null }[] | null
}

// Exported so the actual send gate (share-portal-chat/route.ts) checks the
// SAME list this picker uses to decide what's even offered — two
// independently-maintained copies of this rule is how they'd quietly drift
// apart the next time a status is added (bug-hunter finding, 2026-09-04).
export const ACTIVE_ACCOUNT_STATUSES = new Set(["Active", "Suspended"])

/**
 * Pure transform: one contact row -> zero or more send candidates. Exported
 * (and separately unit-tested) so the two filters a council review added —
 * drop a never-onboarded contact entirely, drop a closed/cancelled company —
 * are tested without a database.
 */
export function toCandidates(c: ContactRow): PortalDestinationCandidate[] {
  if (!c.email || !c.portal_email_sent_at) return []
  const contactName = c.full_name?.trim() || c.email
  const out: PortalDestinationCandidate[] = [
    { contactId: c.id, contactName, contactEmail: c.email, kind: "personal", accountId: null, companyName: null },
  ]
  const seenAccountIds = new Set<string>()
  for (const link of c.account_contacts ?? []) {
    const acct = link.accounts
    if (!acct || seenAccountIds.has(acct.id) || !ACTIVE_ACCOUNT_STATUSES.has(acct.status)) continue
    seenAccountIds.add(acct.id)
    out.push({
      contactId: c.id,
      contactName,
      contactEmail: c.email,
      kind: "company",
      accountId: acct.id,
      companyName: acct.company_name,
    })
  }
  return out
}

export async function searchPortalDestinations(query: string): Promise<PortalDestinationCandidate[]> {
  const term = escapeIlikeTerm(query)
  if (term.length < 2) return []
  const pattern = `%${term}%`

  // Two passes, merged: contacts matched by their own name/email, and
  // contacts matched via their company's name (so typing a company surfaces
  // its people too) -- mirrors search-accounts/route.ts's two-pass shape.
  const selectCols = "id, full_name, email, portal_email_sent_at, account_contacts(account_id, accounts(id, company_name, status))"

  const [byContact, byCompany] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select(selectCols)
      .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
      .limit(MAX_CANDIDATES),
    supabaseAdmin
      .from("contacts")
      .select(`${selectCols}, account_contacts!inner(account_id, accounts!inner(id, company_name, status))`)
      .ilike("account_contacts.accounts.company_name", pattern)
      .limit(MAX_CANDIDATES),
  ])

  const byId = new Map<string, ContactRow>()
  for (const row of [...(byContact.data ?? []), ...(byCompany.data ?? [])] as unknown as ContactRow[]) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }

  const candidates = Array.from(byId.values()).flatMap(toCandidates)
  return candidates.slice(0, MAX_CANDIDATES)
}
