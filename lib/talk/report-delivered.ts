/**
 * The RECEIVING side of the grey double tick (dev job c1e326dd): after this device has loaded its chat list, tell the
 * server "I have these conversations up to here". Only conversations with something new from someone else are reported,
 * each only once per newest-message time (so a 10-second poll does not become 10-second requests).
 * Pure helper `deliveryItems` is unit-tested; `reportDelivered` is the thin fetch around it.
 */

export interface DeliverableThread {
  id: string
  thread_type: string
  unread_count?: number | null
  last_message_at?: string | null
}

/** Which threads to report now, given what was already reported (`sent`: thread id → last_message_at reported). */
export function deliveryItems(
  threads: readonly DeliverableThread[],
  sent: Readonly<Record<string, string>>,
): Array<{ thread_id: string; as_of: string }> {
  const out: Array<{ thread_id: string; as_of: string }> = []
  for (const t of threads) {
    if (t.thread_type !== 'dm' && t.thread_type !== 'group') continue
    if (!t.last_message_at || !(Number(t.unread_count) > 0)) continue
    if (sent[t.id] === t.last_message_at) continue
    out.push({ thread_id: t.id, as_of: t.last_message_at })
  }
  return out
}

const reported: Record<string, string> = {}

/** Fire-and-forget; never throws, never blocks the screen. */
export function reportDelivered(threads: readonly DeliverableThread[]): void {
  if (typeof fetch === 'undefined') return
  const items = deliveryItems(threads, reported)
  if (items.length === 0) return
  for (const i of items) reported[i.thread_id] = i.as_of
  void fetch('/api/team/delivered', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }), keepalive: true,
  }).then(r => { if (!r.ok) for (const i of items) delete reported[i.thread_id] }).catch(() => { for (const i of items) delete reported[i.thread_id] })
}
