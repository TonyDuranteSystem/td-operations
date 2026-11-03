/**
 * "Load earlier messages" for TD Talk (Antonio, 3 Nov 2026 audit: a chat only ever showed its newest 500 messages — older ones, search and copy-link jumps could not reach them).
 * The newest 500 keep refreshing as before (`mergeSnapshot`); older pages the person asked for live in their OWN list, so the 10-second refresh can never drop them.
 * Pure rules, unit-tested; `talk-app.tsx` does the fetching.
 */
import type { TalkMessage } from '@/lib/talk/chat-model'

/** How many older messages one tap adds. */
export const EARLIER_PAGE = 200
/** A jump to an old message (a copied link, a quote) stops looking after this many pages (4,000 messages). */
export const MAX_JUMP_PAGES = 20

function at(m: Pick<TalkMessage, 'created_at'>): number { return Date.parse(m.created_at) || 0 }

/** The older pages already loaded plus a new (even older) page, each message once, oldest first. */
export function mergeEarlier(loaded: readonly TalkMessage[], page: readonly TalkMessage[]): TalkMessage[] {
  return dedupeSorted([...page, ...loaded])
}

/** What the chat shows: the older pages, then the live window. A message that is in both (the window slid) is shown once, from the live window (it has the newest edits and reactions). */
export function combineHistory(older: readonly TalkMessage[], live: readonly TalkMessage[]): TalkMessage[] {
  if (older.length === 0) return live as TalkMessage[]
  const liveIds = new Set(live.map(m => m.id))
  return dedupeSorted([...older.filter(m => !liveIds.has(m.id)), ...live])
}

function dedupeSorted(list: readonly TalkMessage[]): TalkMessage[] {
  const seen = new Set<string>()
  const out: TalkMessage[] = []
  for (const m of list) { if (!seen.has(m.id)) { seen.add(m.id); out.push(m) } }
  return out.sort((a, b) => at(a) - at(b))
}

/** The time to ask the server for messages BEFORE: the oldest message on screen (its own `created_at`, untouched). Null when nothing is loaded. */
export function earlierCursor(shown: readonly TalkMessage[]): string | null {
  let oldest: TalkMessage | null = null
  for (const m of shown) { if (m.local) continue; if (!oldest || at(m) < at(oldest)) oldest = m }
  return oldest ? oldest.created_at : null
}
