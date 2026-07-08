/**
 * Person-thread ↔ company scope expansion, shared between the Messages feed
 * and the What's New feed (+ its purple-dot counter).
 *
 * A person-level (contact) thread is a SUPERSET view: it shows rows tagged to
 * the contact PLUS rows tagged ONLY to one of the contact's linked companies
 * (contact_id NULL, account_id linked). Rows tagged with BOTH ids belong to
 * their tagged contact's thread only — same rule the Messages feed has applied
 * since the unified per-contact thread shipped (app/api/portal/chat/route.ts).
 *
 * Why shared: the What's New feed originally re-implemented thread scoping as
 * a strict contact_id match, so company-only system notes (e.g. the member-info
 * submission for Prowave LLC, 2026-07-06) were visible in Messages but never in
 * What's New and never lit the purple dot. Both feeds now derive scope from the
 * helpers below so the two definitions cannot drift again.
 *
 * The contact → linked-account lookup itself is lib/portal-auth.ts
 * getClientAccountIds — reused, not duplicated.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * PostgREST `.or()` filter for one contact's thread: rows tagged to the
 * contact, plus company-only rows on the contact's linked accounts. With no
 * linked accounts it degrades to the plain contact match.
 *
 * `excludeAccountIds` (staff inbox, 2026-07-08): accounts whose messages live
 * in their OWN account-level thread (multi-member LLCs) and must NOT also
 * appear in the person thread — "one message, one staff thread" (Adam Mihaly /
 * LUMA duplicate fix). Contact-tagged rows on an excluded account are dropped;
 * company-only rows are limited to the non-excluded linked accounts. Empty
 * exclusion list ⇒ historical superset, byte-identical filter string.
 */
export function contactThreadOrFilter(
  contactId: string,
  linkedAccountIds: string[],
  excludeAccountIds: string[] = [],
): string {
  if (excludeAccountIds.length === 0) {
    if (linkedAccountIds.length === 0) return `contact_id.eq.${contactId}`
    return `contact_id.eq.${contactId},and(contact_id.is.null,account_id.in.(${linkedAccountIds.join(",")}))`
  }
  const excluded = new Set(excludeAccountIds)
  const companyOnlyIds = linkedAccountIds.filter((id) => !excluded.has(id))
  const contactArm = `and(contact_id.eq.${contactId},or(account_id.is.null,account_id.not.in.(${excludeAccountIds.join(",")})))`
  if (companyOnlyIds.length === 0) return contactArm
  return `${contactArm},and(contact_id.is.null,account_id.in.(${companyOnlyIds.join(",")}))`
}

/**
 * Of the given account_contacts links, which accounts are multi-member (2+
 * distinct linked contacts)? Pure — DB rows come from the caller.
 */
export function pickMultiMemberAccounts(
  links: { account_id: string; contact_id: string }[],
): string[] {
  const contactsByAccount = new Map<string, Set<string>>()
  for (const l of links) {
    if (!l.account_id || !l.contact_id) continue
    const set = contactsByAccount.get(l.account_id) ?? new Set<string>()
    set.add(l.contact_id)
    contactsByAccount.set(l.account_id, set)
  }
  return Array.from(contactsByAccount.entries())
    .filter(([, contacts]) => contacts.size > 1)
    .map(([accountId]) => accountId)
}

/**
 * DB half of pickMultiMemberAccounts: which of `accountIds` currently have 2+
 * linked contacts. Mirrors the structural definition in
 * get_portal_chat_threads_v2 (migration 20260708-2000) so the staff message
 * view and the thread list can never disagree on which accounts own their own
 * thread. Empty input short-circuits without a query.
 */
export async function multiMemberAccountIds(
  accountIds: string[],
): Promise<string[]> {
  if (accountIds.length === 0) return []
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id, contact_id")
    .in("account_id", accountIds)
  return pickMultiMemberAccounts(
    (data ?? []) as { account_id: string; contact_id: string }[],
  )
}

/**
 * account_id → linked contact ids, batched, for counts bucketing. Empty input
 * short-circuits without a query.
 */
export async function linkedContactIdsByAccount(
  accountIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (accountIds.length === 0) return map
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id, contact_id")
    .in("account_id", accountIds)
  for (const r of data ?? []) {
    const acct = r.account_id as string
    const list = map.get(acct) ?? []
    list.push(r.contact_id as string)
    map.set(acct, list)
  }
  return map
}

export interface CountableNote {
  account_id: string | null
  contact_id: string | null
}

/**
 * Bucket unhandled What's New notes into per-thread counts. Pure — the DB
 * lookups happen in the caller.
 *
 * Rules (must mirror contactThreadOrFilter so the dot always equals what the
 * panel lists):
 * - account-tagged notes count in that account's bucket (account threads);
 * - notes on a MULTI-MEMBER account (in `multiMemberAccounts`) count ONLY in
 *   that account's bucket — never in a contact bucket. Those accounts have
 *   their own thread; "one message, one staff thread" (2026-07-08);
 * - otherwise, contact-tagged notes count in that contact's bucket;
 * - company-ONLY notes (contact_id null) ALSO count for every contact linked
 *   to that account — that is the superset view of a person thread;
 * - both-tagged notes count only for their tagged contact (not co-members);
 * - `total` counts each distinct note once (global sidebar badge).
 */
export function bucketWhatsNewCounts(
  notes: CountableNote[],
  contactsByAccount: Map<string, string[]>,
  multiMemberAccounts: Set<string> = new Set(),
): { by_account: Record<string, number>; by_contact: Record<string, number>; total: number } {
  const by_account: Record<string, number> = {}
  const by_contact: Record<string, number> = {}
  let total = 0
  for (const n of notes) {
    if (n.account_id) by_account[n.account_id] = (by_account[n.account_id] ?? 0) + 1
    const ownedByAccountThread = !!n.account_id && multiMemberAccounts.has(n.account_id)
    if (!ownedByAccountThread) {
      if (n.contact_id) {
        by_contact[n.contact_id] = (by_contact[n.contact_id] ?? 0) + 1
      } else if (n.account_id) {
        for (const c of contactsByAccount.get(n.account_id) ?? []) {
          by_contact[c] = (by_contact[c] ?? 0) + 1
        }
      }
    }
    if (n.account_id || n.contact_id) total += 1
  }
  return { by_account, by_contact, total }
}
