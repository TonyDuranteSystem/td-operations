/**
 * Pure merge rule for a client portal chat REFRESH (wake / reconnect / manual ↻).
 *
 * A refresh refetches the newest `limit` messages and must REPLACE the list, not
 * union into it: a row soft-deleted while the socket was down is simply absent
 * from the response, and only replacement expresses that absence (R100 — the
 * client view must fully hide a deleted message). Two things replacement alone
 * gets wrong, both found by the 2026-09-29 council pass (dev job 05d997f2):
 *
 *  1. A message that arrives (realtime INSERT, or the client's own send) AFTER
 *     the refetch's snapshot was taken is missing from the response — a blind
 *     replace makes it vanish from the screen with no further event. That is
 *     exactly the "the email said new message but it isn't there" symptom.
 *     → `liveIds`: every id received live since the fetch started is kept.
 *  2. A client who paged back past the refetch window (or the route's 100-row
 *     cap) would lose that history on every wake, and `loadMore` would stop.
 *     → held rows OLDER than the oldest fetched row are kept, but only when the
 *       window was full (a short response means we already have everything, so
 *       an older held row that isn't in it was deleted and must go).
 *
 * Rows inside the fetched window that are missing from the response are dropped
 * (deleted), unless they are in `liveIds`.
 */

export interface MergeableMessage {
  id: string
  created_at: string
}

function ts(m: MergeableMessage): number {
  const t = Date.parse(m.created_at)
  return Number.isNaN(t) ? 0 : t
}

/** Ascending by created_at; ties broken by the raw string, then id, for a stable order. */
export function sortMessagesAscending<T extends MergeableMessage>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const d = ts(a) - ts(b)
    if (d !== 0) return d
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export function mergeRefreshedMessages<T extends MergeableMessage>(args: {
  /** The refetch response (any order). */
  fetched: T[]
  /** What is on screen right now (at the moment the response is applied). */
  held: T[]
  /** The limit the refetch asked for. */
  limit: number
  /** Ids received live (realtime insert or own send) since the refetch started. */
  liveIds: ReadonlySet<string>
}): { messages: T[]; windowFull: boolean; keptOlder: number } {
  const { fetched, held, limit, liveIds } = args
  const byId = new Map<string, T>()
  for (const m of fetched) byId.set(m.id, m)

  const windowFull = fetched.length >= limit
  let oldestFetched = Infinity
  for (const m of fetched) oldestFetched = Math.min(oldestFetched, ts(m))

  let keptOlder = 0
  for (const m of held) {
    if (byId.has(m.id)) continue
    if (liveIds.has(m.id)) {
      byId.set(m.id, m)
      continue
    }
    if (windowFull && fetched.length > 0 && ts(m) < oldestFetched) {
      byId.set(m.id, m)
      keptOlder++
    }
  }

  return { messages: sortMessagesAscending(Array.from(byId.values())), windowFull, keptOlder }
}
