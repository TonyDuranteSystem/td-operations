/**
 * Admin send-scope rule for portal chat — the ONE invariant every staff-driven
 * send surface must pass before inserting into portal_messages.
 *
 * Born from the 2026-08-07 cross-company leak (dev job 4bad3094): the staff
 * inbox auto-stamped person-thread replies with the contact's first open
 * company, so 28 private messages about one client's new company rendered in
 * another member's portal for two months. The server trusted the UI-supplied
 * account id with no check.
 *
 * The rule (staff/admin-originated sends only — client and teammate sends keep
 * their own existing gates in the chat route):
 *
 *   1. A message addressed to a PERSON (contact_id in the request body) stays
 *      personal (account_id NULL) unless the sender EXPLICITLY declares
 *      company scope (sender_context='company'). An undeclared
 *      contact+account pair is exactly the shape that produced the leak, so
 *      it is rejected, never silently accepted.
 *   2. Any declared company must actually be one of that person's companies
 *      (account_contacts link) — verified server-side, never trusted from
 *      the UI.
 *
 * Surfaces wired to this rule: POST /api/portal/chat (staff inbox +
 * action board), MCP portal_chat_send, the topic starter, correspondence
 * upload, admin document upload, and the AI worker's portal send.
 *
 * `decideAdminSendScope` is pure (DB-free) so the invariant itself is
 * unit-testable; the two DB helpers take an injectable client for the same
 * reason.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { normalizeCapabilities, hasCapability } from '@/lib/portal/team/capabilities'

export type AdminSendScopeInput = {
  accountId: string | null
  contactId: string | null
  senderContext: 'person' | 'company' | null
}

export type AdminSendScopeDecision =
  | { ok: true; needsLinkCheck: boolean; error?: undefined }
  | { ok: false; error: string; needsLinkCheck?: undefined }

/**
 * Pure decision: is this admin send-shape allowed, and does it need the
 * contact↔account link verified before insert?
 */
export function decideAdminSendScope(input: AdminSendScopeInput): AdminSendScopeDecision {
  const { accountId, contactId, senderContext } = input

  if (senderContext === 'company' && !accountId) {
    return { ok: false, error: 'sender_context=company requires account_id' }
  }
  if (senderContext === 'person' && accountId) {
    return { ok: false, error: 'sender_context=person must not include account_id' }
  }
  // The leak shape: person-addressed body carrying a company tag with no
  // explicit declaration. Reject — the caller must either drop the account
  // (personal send) or declare sender_context='company' (which then requires
  // the membership check below).
  if (contactId && accountId && senderContext !== 'company') {
    return {
      ok: false,
      error:
        "This message is addressed to a person but carries a company tag. Send it as personal (no account_id), or explicitly pick the company (sender_context='company') so everyone in that company is meant to see it.",
    }
  }
  return { ok: true, needsLinkCheck: !!(contactId && accountId) }
}

/** Minimal query surface so callers/tests can inject a fake client. */
type DbClient = {
  from: (table: string) => {
    select: (
      cols: string,
      opts?: { count?: 'exact'; head?: boolean },
    ) => {
      eq: (col: string, val: string) => {
        eq?: unknown
        limit?: unknown
      } & PromiseLike<{ data: unknown; count?: number | null; error: { message: string } | null }>
    }
  }
}

/**
 * Is the contact actually a member of the account? (account_contacts link)
 * Fails CLOSED: a query error reports "not linked" — a blocked legitimate send
 * surfaces immediately and loudly; a silently allowed wrong-scope send leaks.
 */
export async function isContactLinkedToAccount(
  accountId: string,
  contactId: string,
  db: DbClient = supabaseAdmin as unknown as DbClient,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
    if (error || !Array.isArray(data)) return false
    return (data as { contact_id: string }[]).some(l => l.contact_id === contactId)
  } catch {
    return false
  }
}

export type AccountAudience = {
  contactCount: number
  chatTeammateCount: number
}

/**
 * Who can read a company-scoped message on this account: every linked contact
 * plus every ACTIVE portal teammate with the 'chat' capability. Used by the
 * staff composer to warn when the audience is wider than the one person being
 * answered — including a SOLO company with chat-capable teammates (the case a
 * members-only count misses).
 */
export async function accountAudience(
  accountId: string,
  db: DbClient = supabaseAdmin as unknown as DbClient,
): Promise<AccountAudience> {
  let contactCount = 0
  let chatTeammateCount = 0
  try {
    const { data } = await db.from('account_contacts').select('contact_id').eq('account_id', accountId)
    contactCount = Array.isArray(data) ? data.length : 0
  } catch {
    contactCount = 0
  }
  try {
    const { data } = await db
      .from('portal_team_members')
      .select('capabilities, status')
      .eq('account_id', accountId)
    const rows = Array.isArray(data) ? (data as { capabilities: unknown; status: string | null }[]) : []
    chatTeammateCount = rows.filter(
      r => r.status === 'active' && hasCapability(normalizeCapabilities(r.capabilities), 'chat'),
    ).length
  } catch {
    chatTeammateCount = 0
  }
  return { contactCount, chatTeammateCount }
}

/**
 * Deterministic member tag for an admin send into an account thread.
 * Order: reply-to author (if a linked member) → last client sender on the
 * account → primary linked contact → first linked contact by contact_id.
 * Returns null only when the account has no linked contacts at all.
 *
 * Moved here from app/api/portal/chat/route.ts (2026-08-07) so the MCP send
 * tool shares it instead of its old arbitrary `.limit(1)` pick — the same
 * wrong-member bug class the route fixed on 2026-07-08.
 */
export async function resolveAdminReplyContact(
  accountId: string,
  replyToId: string | null,
): Promise<string | null> {
  const admin = supabaseAdmin
  const { data: links } = await admin
    .from('account_contacts')
    .select('contact_id, is_primary')
    .eq('account_id', accountId)
  const linked = (links ?? []) as { contact_id: string; is_primary: boolean | null }[]
  if (linked.length === 0) return null
  const linkedIds = new Set(linked.map(l => l.contact_id))

  // 1. Author of the message being replied to.
  if (replyToId) {
    const { data: parent } = await admin
      .from('portal_messages')
      .select('contact_id, sender_type')
      .eq('id', replyToId)
      .maybeSingle()
    if (parent?.sender_type === 'client' && parent.contact_id && linkedIds.has(parent.contact_id)) {
      return parent.contact_id
    }
  }

  // 2. Last client sender in this account thread.
  const { data: lastClient } = await admin
    .from('portal_messages')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('sender_type', 'client')
    .not('contact_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastClient?.contact_id && linkedIds.has(lastClient.contact_id)) {
    return lastClient.contact_id
  }

  // 3. Primary linked contact, else first by contact_id (stable order).
  const sorted = [...linked].sort((a, b) => a.contact_id.localeCompare(b.contact_id))
  return sorted.find(l => l.is_primary)?.contact_id ?? sorted[0].contact_id
}
