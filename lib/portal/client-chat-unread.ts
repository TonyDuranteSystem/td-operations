/**
 * THE definition of "unread" for a client in the portal chat (dev job 05d997f2,
 * Phase 2 — Antonio: "read" must mean the client actually looked at that tab).
 *
 * Before this, three places counted differently and none of them agreed:
 *  - the sidebar / phone-icon badge counted the contact's own rows only
 *    (contact_id = me) across every company;
 *  - the tab badges counted whatever happened to be loaded on screen;
 *  - opening the chat marked EVERYTHING read, so both dropped to 0 before the
 *    client saw a message sitting in another tab (William Canzi's reminders).
 *
 * One rule now, used by the sidebar total, the per-tab badges and the read
 * route's response:
 *   a message is unread for the client when it was sent by the team
 *   (sender_type 'admin'), is not deleted, is in a view the client can
 *   actually open (one of their companies, or their own company-less thread),
 *   and is either never read or explicitly kept unread by the client.
 * System notices (out-of-office, internal chat-events) are never counted.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PortalChatEntity } from '@/lib/portal/queries'

export interface UnreadRow {
  account_id: string | null
  contact_id: string | null
  topic: string | null
}

export interface ClientUnreadSummary {
  /** Distinct unread messages the client can reach — the sidebar / icon number. */
  total: number
  /** Per chat view (entity id) → per tab ('' = General) → count. */
  byEntity: Record<string, Record<string, number>>
}

/** '' for General — the chat treats null/empty topic as the General tab. */
export function topicKey(topic: string | null | undefined): string {
  return typeof topic === 'string' ? topic : ''
}

/**
 * Pure: assign unread rows to the chat views that show them.
 * A company row belongs to that company's view. A company-less row (the
 * contact's personal thread) is shown in EVERY view that hosts personal
 * messages (the Personal view, formations, and each company the client owns
 * alone), so it is listed under each of them — but counted once in `total`.
 * Rows no view can show are ignored (not counted): an unread number the
 * client can never clear is exactly the stuck-badge bug this replaces.
 */
export function summarizeClientUnread(rows: UnreadRow[], entities: PortalChatEntity[], contactId: string): ClientUnreadSummary {
  const byEntity: Record<string, Record<string, number>> = {}
  const companyEntity = new Map<string, PortalChatEntity>()
  const personalHosts: PortalChatEntity[] = []
  for (const e of entities) {
    if (e.kind === 'company' && e.accountId) companyEntity.set(e.accountId, e)
    if (e.kind === 'personal' || e.kind === 'formation' || e.includePersonalNull) personalHosts.push(e)
  }
  const bump = (entityId: string, key: string) => {
    const t = (byEntity[entityId] ??= {})
    t[key] = (t[key] ?? 0) + 1
  }
  let total = 0
  for (const r of rows) {
    const key = topicKey(r.topic)
    if (r.account_id) {
      const e = companyEntity.get(r.account_id)
      if (!e) continue
      bump(e.id, key)
      total++
    } else if (r.contact_id === contactId && personalHosts.length > 0) {
      for (const e of personalHosts) bump(e.id, key)
      total++
    }
  }
  return { total, byEntity }
}

/** Unread rows the client could possibly see (filtered further by summarizeClientUnread). */
export async function fetchClientUnreadRows(contactId: string, accountIds: string[]): Promise<UnreadRow[]> {
  const scope = accountIds.length > 0
    ? `account_id.in.(${accountIds.join(',')}),and(account_id.is.null,contact_id.eq.${contactId})`
    : `and(account_id.is.null,contact_id.eq.${contactId})`
  // Two queries (never read / kept unread) rather than a second .or() — one
  // PostgREST `or` group per query keeps the filter unambiguous.
  const base = () => supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, topic')
    .eq('sender_type', 'admin')
    .is('deleted_at', null)
    .or(scope)
    .limit(2000)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
  const [neverRead, keptUnread] = await Promise.all([base().is('read_at', null), (base() as any).eq('client_kept_unread', true)])
  if (neverRead.error) throw new Error(neverRead.error.message)
  if (keptUnread.error) throw new Error(keptUnread.error.message)
  const byId = new Map<string, UnreadRow>()
  for (const r of [...(neverRead.data ?? []), ...(keptUnread.data ?? [])] as Array<UnreadRow & { id: string }>) {
    byId.set(r.id, { account_id: r.account_id, contact_id: r.contact_id, topic: r.topic })
  }
  return Array.from(byId.values())
}

/** The summary for a signed-in client contact. */
export async function getClientChatUnread(contactId: string): Promise<ClientUnreadSummary> {
  const { getChatEntities } = await import('@/lib/portal/queries')
  const entities = await getChatEntities(contactId)
  const accountIds = entities.filter(e => e.kind === 'company' && e.accountId).map(e => e.accountId as string)
  const rows = await fetchClientUnreadRows(contactId, accountIds)
  return summarizeClientUnread(rows, entities, contactId)
}
