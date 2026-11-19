/**
 * The Contact page's "Message" pop-up: who a staff message to this person can go to.
 *
 * Same shape as the document "eye" pop-up (lib/portal/document-share-message.ts) — the person's personal chat plus each of
 * their companies, with each company's closed flag and the topics already open in each chat — but NOTHING is pre-selected:
 * staff must choose personal or a company every time (the 2026-08-07 leak rule — a message to the wrong chat can reach every
 * member of a company). The send itself is not here: the pop-up posts to POST /api/portal/chat, so every rule of a normal staff
 * send (company/person scope, membership check, portal notification, email throttle) applies unchanged.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolveDocLocale } from "@/lib/portal/document-alerts"
import { buildShareTargets } from "@/lib/portal/document-share-message"
import { contactMessageNotice, type PortalLoginState, type ShareContext } from "@/lib/portal/document-share-text"
import { listAllAuthUsers } from "@/lib/auth-admin-helpers"
import { isMarketingRole } from "@/lib/auth/role-door"

/**
 * Pure: a person's portal login state from their auth user (null = no login). A login is "suspended" when its auth user is
 * banned with a still-in-the-future banned_until — the same rule the Contact page's Portal tab uses.
 */
export function portalLoginStateOf(authUser: { banned_until?: string | null } | null, now: Date = new Date()): PortalLoginState {
  if (!authUser) return { exists: false, suspended: false }
  const bannedUntil = authUser.banned_until ?? null
  return { exists: true, suspended: !!bannedUntil && new Date(bannedUntil) > now }
}

/** The slice of an auth login these checks need. */
export interface LoginLike { email?: string | null; banned_until?: string | null; app_metadata?: { contact_id?: string; role?: string } | null }

/**
 * Pure: one person's portal login state. A client login is tied to a person by `app_metadata.contact_id`, NOT by email — a person can
 * log in under a different email than the one on their CRM record — so a login belongs to the person when EITHER the contact id OR the
 * email matches. A marketing-workspace login is never a client login. exists = some login belongs to them; suspended = none of theirs works.
 */
export function loginStateForContact(contact: { id: string; email: string | null }, logins: LoginLike[], now: Date = new Date()): PortalLoginState {
  const email = (contact.email ?? "").toLowerCase().trim()
  const mine = logins.filter((u) => !isMarketingRole(u.app_metadata?.role) && (u.app_metadata?.contact_id === contact.id || (!!email && (u.email ?? "").toLowerCase().trim() === email)))
  if (mine.length === 0) return { exists: false, suspended: false }
  return { exists: true, suspended: mine.every((u) => portalLoginStateOf(u, now).suspended) }
}

/** Pure: how many of these people have a working (existing, not suspended) portal login. */
export function contactsWithWorkingLogin(contacts: { id: string; email: string | null }[], logins: LoginLike[], now: Date = new Date()): number {
  return contacts.filter((c) => { const s = loginStateForContact(c, logins, now); return s.exists && !s.suspended }).length
}

/**
 * The amber "cannot read it yet" line for this person, worked out when the pop-up OPENS (not per list row). If the logins cannot
 * be looked up, say nothing rather than claim "no portal login" falsely.
 */
async function loginNotice(contact: { id: string; email: string | null }, name: string): Promise<string | undefined> {
  try {
    return contactMessageNotice(name, loginStateForContact(contact, (await listAllAuthUsers()) as LoginLike[])) ?? undefined
  } catch {
    return undefined
  }
}

/** null when the contact does not exist. */
export async function getContactMessageContext(contactId: string): Promise<ShareContext | null> {
  const { data: contact, error } = await supabaseAdmin.from("contacts").select("id, full_name, email").eq("id", contactId).maybeSingle()
  if (error) throw new Error(`Could not read the contact (${error.message}).`)
  if (!contact) return null

  const { data: links } = await supabaseAdmin.from("account_contacts").select("account_id").is("access_revoked_at", null).eq("contact_id", contactId)
  const accountIds: string[] = []
  for (const l of (links ?? []) as { account_id: string }[]) if (!accountIds.includes(l.account_id)) accountIds.push(l.account_id)

  const built = await buildShareTargets({ accountIds, contactId, defaultAccountId: null, personIsDefault: false })
  // the person's own chat first, then the companies
  const targets = [...built.filter((t) => t.kind === "person"), ...built.filter((t) => t.kind === "company")]
  const locale = await resolveDocLocale(null, contactId)
  const name = ((contact.full_name as string | null) ?? "").trim()
  const notice = await loginNotice({ id: contactId, email: (contact.email as string | null) ?? null }, name)
  return { askable: true, fileName: "", locale, defaultTopic: "", targets, recipientName: name || undefined, ...(notice ? { notice } : {}) }
}
