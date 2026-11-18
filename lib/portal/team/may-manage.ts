/**
 * Team Powers — WHO MAY MANAGE A COMPANY'S TEAM (step 3, 2026-11-17).
 *
 * The rule (Antonio): TD recognises only owners and members. Any CURRENT owner or member of THIS company may add, edit,
 * switch off, remove and reset the passwords of its team. Nobody else — not an authorized representative, an accountant,
 * a partner, a collaborator, someone who left, a stray contact, or a person who is an owner of ANOTHER company.
 *
 *   1. the person must have a CURRENT link to THIS company
 *      (not ended, access not revoked, access not expired);
 *   2. the link's role must be owner / member (owner, Owner, Member, member, Sole Member);
 *   3. if the company has a members list with current rows, the person must be on it — the members list decides who the
 *      owners are (this is what stops a stale or stray "Member" link from managing). A member who has LEFT (end date passed)
 *      is not current. A company that is itself a member is covered by the contact on its row (its representative), who has
 *      an owner / member link like everyone else.
 *      "On the list" = a current row whose contact is this person, OR — only for a row that was never linked to a contact
 *      (4 real companies today: the owner is on the list by name but the row has no contact) — a row whose full name is
 *      exactly this person's name (case and spaces ignored). A row that IS linked to someone else never matches by name.
 *      A company with no current members rows (a single-owner company) is decided by step 2 alone.
 *
 * It replaces the old "one main person" rule (override → SS-4 signer → owner role → sole contact). The override column
 * `accounts.portal_admin_contact_id` is no longer read here (no company uses it).
 * Fails CLOSED: any missing input or database error means "not allowed".
 *
 * `decideMayManageTeam` is PURE (no I/O) so every case is unit-tested without a database.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

/** Roles on account_contacts that mean "this person is an owner / member of the company" (compared lower-case). */
export const OWNER_MEMBER_ROLES = ['owner', 'member', 'sole member'] as const

export interface ManageLink {
  role: string | null
  ended_at: string | null
  access_revoked_at: string | null
  access_until: string | null
}

export interface ManageMemberRow {
  contact_id: string | null
  start_date: string | null
  end_date: string | null
  /** The name on the members list — used ONLY to recognise a row that was never linked to a contact. */
  full_name?: string | null
}

export interface ManageInputs {
  contactId: string
  /** This person's full name (from their contact record). */
  contactName?: string | null
  /** This contact's link to THIS company, or null when there is none. */
  link: ManageLink | null
  /** Every row of THIS company's members list. */
  members: ManageMemberRow[]
}

export type ManageReason = 'ok' | 'no_contact' | 'no_link' | 'link_ended' | 'not_owner_or_member' | 'not_on_members_list'

export interface ManageDecision {
  ok: boolean
  reason: ManageReason
  /** How the person was found on the members list: by their contact, by exact name (unlinked row), or no list to check. */
  matchedBy?: 'contact' | 'name' | 'no_list'
}

/** Names compared the way the rest of the portal does (findCompanyMemberByName): case and repeated spaces ignored. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** The day as YYYY-MM-DD (dates in the members list have no time). */
function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** A members row counts today when it has started and has not ended. */
export function isCurrentMemberRow(row: ManageMemberRow, now: Date): boolean {
  const today = dayOf(now)
  if (row.start_date && row.start_date.slice(0, 10) > today) return false
  if (row.end_date && row.end_date.slice(0, 10) <= today) return false
  return true
}

export function isCurrentLink(link: ManageLink, now: Date): boolean {
  if (link.ended_at) return false
  if (link.access_revoked_at) return false
  if (link.access_until && new Date(link.access_until).getTime() <= now.getTime()) return false
  return true
}

/** PURE. See the file header for the rule. */
export function decideMayManageTeam(input: ManageInputs, now: Date = new Date()): ManageDecision {
  if (!input.contactId) return { ok: false, reason: 'no_contact' }
  if (!input.link) return { ok: false, reason: 'no_link' }
  if (!isCurrentLink(input.link, now)) return { ok: false, reason: 'link_ended' }
  const role = (input.link.role ?? '').trim().toLowerCase()
  if (!(OWNER_MEMBER_ROLES as readonly string[]).includes(role)) return { ok: false, reason: 'not_owner_or_member' }

  const current = input.members.filter((m) => isCurrentMemberRow(m, now))
  if (current.length === 0) return { ok: true, reason: 'ok', matchedBy: 'no_list' }
  if (current.some((m) => m.contact_id === input.contactId)) return { ok: true, reason: 'ok', matchedBy: 'contact' }
  const me = normalizeName(input.contactName)
  if (me && current.some((m) => !m.contact_id && normalizeName(m.full_name) === me)) return { ok: true, reason: 'ok', matchedBy: 'name' }
  return { ok: false, reason: 'not_on_members_list' }
}

export interface MayManageDeps {
  gather: (contactId: string, accountId: string) => Promise<{ link: ManageLink | null; members: ManageMemberRow[]; contactName?: string | null }>
  now?: () => Date
}

const defaultDeps: MayManageDeps = {
  gather: async (contactId, accountId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabaseAdmin as any
    const [linkRes, membersRes, contactRes] = await Promise.all([
      sb
        .from('account_contacts')
        .select('role, ended_at, access_revoked_at, access_until')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .limit(1)
        .maybeSingle(),
      sb.from('members').select('contact_id, start_date, end_date, full_name').eq('account_id', accountId),
      sb.from('contacts').select('full_name').eq('id', contactId).maybeSingle(),
    ])
    // Fail CLOSED: if any read fails we cannot prove the person may manage.
    const failed = linkRes.error || membersRes.error || contactRes.error
    if (failed) throw new Error(failed.message || 'read failed')
    return {
      link: (linkRes.data as ManageLink | null) ?? null,
      members: (membersRes.data as ManageMemberRow[] | null) ?? [],
      contactName: (contactRes.data as { full_name: string | null } | null)?.full_name ?? null,
    }
  },
}

/** True when this contact may manage this company's team. Never throws: any trouble means "no". */
export async function mayManageTeam(contactId: string, accountId: string, deps: MayManageDeps = defaultDeps): Promise<boolean> {
  if (!contactId || !accountId) return false
  try {
    const { link, members, contactName } = await deps.gather(contactId, accountId)
    return decideMayManageTeam({ contactId, contactName, link, members }, deps.now?.() ?? new Date()).ok
  } catch (err) {
    // eslint-disable-next-line no-console -- a failed permission read must be visible in the server log
    console.error('[may-manage-team] could not decide, refusing:', err instanceof Error ? err.message : err)
    return false
  }
}
