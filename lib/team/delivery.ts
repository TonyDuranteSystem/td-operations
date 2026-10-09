/**
 * "Delivered" ticks — server side (dev job c1e326dd). The RECEIVING device reports how far it has received a direct
 * message / group chat; we keep one forward-only pointer per person per conversation (`internal_thread_delivery`).
 * The sender's screen compares its message time against the other person's pointer (see lib/talk/chat-model.ts::tickState).
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { listGroupMemberIds } from '@/lib/team/groups'
import { isGroupMember } from '@/lib/team/groups-rules'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export const MAX_DELIVERY_ITEMS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface DeliveryItem { thread_id: string; as_of: string }
// `as_of` is optional: a service worker acking a push has no list to read a time from, so it sends only the thread and the server's own clock is used (no device-clock skew).

/** Pure: keep well-formed items only, clamp each `as_of` to `now` (a device cannot claim a message from the future), cap the count. */
export function normalizeDeliveryItems(raw: unknown, now: Date): DeliveryItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Map<string, number>()
  for (const it of raw.slice(0, MAX_DELIVERY_ITEMS)) {
    const o = it as { thread_id?: unknown; as_of?: unknown }
    if (typeof o?.thread_id !== 'string' || !UUID.test(o.thread_id)) continue
    const t = o.as_of === undefined || o.as_of === null ? now.getTime() : (typeof o.as_of === 'string' ? Date.parse(o.as_of) : NaN)
    if (Number.isNaN(t)) continue
    const clamped = Math.min(t, now.getTime())
    const id = o.thread_id.toLowerCase()
    seen.set(id, Math.max(seen.get(id) ?? 0, clamped))
  }
  return Array.from(seen, ([thread_id, ms]) => ({ thread_id, as_of: new Date(ms).toISOString() }))
}

/** Record the reports for `userId`. Only direct messages the person is in and groups they belong to count; anything else is ignored. Returns how many were stored. */
export async function markDelivered(userId: string, rawItems: unknown, now: Date = new Date()): Promise<number> {
  const items = normalizeDeliveryItems(rawItems, now)
  if (items.length === 0) return 0
  const { data: threads } = await db().from('internal_threads').select('id, thread_type, dm_key').in('id', items.map(i => i.thread_id))
  let stored = 0
  for (const t of (threads ?? []) as Array<{ id: string; thread_type: string; dm_key: string | null }>) {
    let allowed = false
    if (t.thread_type === 'dm') allowed = String(t.dm_key ?? '').split(':').includes(userId)
    else if (t.thread_type === 'group') allowed = isGroupMember(await listGroupMemberIds(t.id), userId)
    if (!allowed) continue
    const item = items.find(i => i.thread_id === t.id.toLowerCase())
    if (!item) continue
    const { error } = await db().rpc('mark_thread_delivered', { p_user_id: userId, p_thread_id: t.id, p_as_of: item.as_of })
    if (!error) stored++
  }
  return stored
}
