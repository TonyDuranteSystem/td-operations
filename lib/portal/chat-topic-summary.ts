/**
 * Portal chat — the TOPIC LIST of a conversation, independent of how many messages are on screen
 * (Antonio, 2026-11-24: "if there are topics linked to older messages, the topic disappears until I click Older messages").
 *
 * Before this, both chat screens (staff Portal Chats and the client portal chat) built their topic tabs, the tab order and the
 * unread badges ONLY from the newest 50 messages they had loaded, so a topic whose messages were all older had no tab at all.
 * The server now also answers `GET /api/portal/chat?...&topics=1` with one entry per topic; the screens show
 * "loaded topics ∪ these". A topic is its exact text — never trimmed, lower-cased or merged — and General is the empty key ''.
 *
 * Everything here is pure (no database, no React) so the rules are unit tested; the route and the two screens call it.
 */
import { parseTimestamp, sortMessagesAscending } from '@/lib/portal/chat-refresh-merge'

/** The tab key of the General tab (a message with no topic). A real topic literally named "General" is a different key. */
export const GENERAL_TOPIC_KEY = ''

/** The most rows one summary query reads. A larger conversation sets `truncated` and the screens fall back to what is loaded. */
export const TOPIC_SUMMARY_ROW_LIMIT = 1000

/** Messages one topic tab loads per page (the route caps `limit` at 100). */
export const TOPIC_PAGE_SIZE = 50
/** Messages one "Older messages" click loads in a topic tab. */
export const TOPIC_OLDER_PAGE_SIZE = 100

export interface TopicSummaryEntry {
  /** '' = General, otherwise the topic text exactly as stored. */
  topic: string
  /** created_at of the newest visible message in this topic (null when only unread rows are known). */
  lastAt: string | null
  /** Unread messages in this topic, by the same rule as the screen's own badge. */
  unread: number
  /** created_at of the newest UNREAD message in this topic (null when none / not known). Opening on "the topic with the newest unread message" uses it. */
  lastUnreadAt?: string | null
}

/** The tab key of a message: its topic text, or '' (General) when it has none. */
export function topicKeyOf(topic: string | null | undefined): string {
  return typeof topic === 'string' ? topic : GENERAL_TOPIC_KEY
}

/** Does this message belong in the tab with this key? General = no topic (null or ''); a named tab matches exactly. */
export function messageInTopic(msg: { topic?: string | null }, key: string): boolean {
  return key === GENERAL_TOPIC_KEY ? !msg.topic : msg.topic === key
}

export type TopicParam = { kind: 'none' } | { kind: 'general' } | { kind: 'named'; name: string }

/**
 * `topic` query parameter of the chat read route. Absent = no topic filter (the whole conversation, as always);
 * present but empty = the General tab; anything else = exactly that topic (NOT trimmed — a stored topic is already trimmed
 * at write time, and trimming here could make a tab load nothing).
 */
export function parseTopicParam(searchParams: URLSearchParams): TopicParam {
  if (!searchParams.has('topic')) return { kind: 'none' }
  const raw = searchParams.get('topic') ?? ''
  return raw === '' ? { kind: 'general' } : { kind: 'named', name: raw }
}

export interface NamedTopicRow {
  topic: string | null
  created_at: string
}

/**
 * Assemble the summary from the narrow reads the route makes:
 *  - `namedRows`: visible messages that carry a topic (topic, created_at) — gives each topic's name and newest message;
 *  - `generalLastAt`: newest visible General message (or null);
 *  - `unreadTopics`: one entry (the row's topic, null/'' = General) per unread message — OR `unreadByKey` already counted.
 * A topic that has unread messages but no visible row is still listed (its unread count must be reachable).
 * Newest activity first; General is only listed when it has messages or unread (the screens always show General anyway).
 */
export function buildTopicSummary(args: {
  namedRows: readonly NamedTopicRow[]
  generalLastAt: string | null
  unreadTopics?: ReadonlyArray<string | null>
  /** Same as `unreadTopics` but with each unread message's time (lets the list say which topic has the NEWEST unread message). */
  unreadRows?: ReadonlyArray<{ topic: string | null; created_at: string }>
  unreadByKey?: Readonly<Record<string, number>>
}): TopicSummaryEntry[] {
  const byKey = new Map<string, TopicSummaryEntry>()
  const touch = (key: string): TopicSummaryEntry => {
    let e = byKey.get(key)
    if (!e) { e = { topic: key, lastAt: null, unread: 0 }; byKey.set(key, e) }
    return e
  }
  const newer = (a: string | null, b: string): string => (a === null || parseTimestamp(b) > parseTimestamp(a) ? b : a)

  for (const r of args.namedRows) {
    const key = topicKeyOf(r.topic)
    const e = touch(key)
    e.lastAt = newer(e.lastAt, r.created_at)
  }
  if (args.generalLastAt) {
    const e = touch(GENERAL_TOPIC_KEY)
    e.lastAt = newer(e.lastAt, args.generalLastAt)
  }
  for (const t of args.unreadTopics ?? []) touch(topicKeyOf(t)).unread += 1
  for (const r of args.unreadRows ?? []) {
    const e = touch(topicKeyOf(r.topic))
    e.unread += 1
    e.lastUnreadAt = newer(e.lastUnreadAt ?? null, r.created_at)
  }
  for (const [key, n] of Object.entries(args.unreadByKey ?? {})) {
    if (n > 0) touch(key).unread += n
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const d = (b.lastAt ? parseTimestamp(b.lastAt) : -Infinity) - (a.lastAt ? parseTimestamp(a.lastAt) : -Infinity)
    return d !== 0 ? d : a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0
  })
}

/** The topic a freshly opened conversation should open on, from the server summary (null = stay on General). General wins when it has unread; else the topic with the newest UNREAD message. */
export function pickUnreadTopicFromSummary(summary: readonly TopicSummaryEntry[]): string | null {
  const general = summary.find(e => e.topic === GENERAL_TOPIC_KEY)
  if (general && general.unread > 0) return null
  let best: TopicSummaryEntry | null = null
  let bestTime = -Infinity
  for (const e of summary) {
    if (e.topic === GENERAL_TOPIC_KEY || e.unread <= 0) continue
    const at = e.lastUnreadAt ?? e.lastAt
    const t = at ? parseTimestamp(at) : -Infinity
    if (!best || t > bestTime) { best = e; bestTime = t }
  }
  return best ? best.topic : null
}

export interface TopicViewMessage {
  id: string
  created_at: string
  topic?: string | null
  deleted_at?: string | null
}

/**
 * What the active tab shows: the messages the screen already holds for this topic (its live window and any older pages opened
 * for a jump) plus the tab's OWN loaded pages, one copy per id, oldest first.
 *  - The held (window) copy wins: realtime keeps it fresh, the tab's own pages can be a refetch behind.
 *  - A deletion wins from either side: a message deleted in either copy is deleted (R100 — a deleted message must not come back
 *    because one copy was a refetch behind).
 */
export function mergeTopicView<T extends TopicViewMessage>(args: {
  topicKey: string
  held: readonly T[]
  tabPages: readonly T[]
}): T[] {
  const byId = new Map<string, T>()
  for (const m of args.tabPages) if (messageInTopic(m, args.topicKey)) byId.set(m.id, m)
  for (const m of args.held) {
    if (!messageInTopic(m, args.topicKey)) continue
    const other = byId.get(m.id)
    byId.set(m.id, other && other.deleted_at && !m.deleted_at ? other : m)
  }
  return sortMessagesAscending(Array.from(byId.values()))
}

/** The oldest created_at among a tab's OWN loaded pages (the cursor its "Older messages" button pages before), or null when none. */
export function oldestCreatedAt(messages: ReadonlyArray<{ created_at: string }>): string | null {
  let best: string | null = null
  for (const m of messages) {
    if (best === null || parseTimestamp(m.created_at) < parseTimestamp(best)) best = m.created_at
  }
  return best
}

/**
 * Fold a newly loaded page into a tab's own pages: one copy per id (the new copy wins), nothing from the page that was
 * soft-deleted while it loaded (`deletedIds`), oldest first.
 */
export function mergeTabPages<T extends TopicViewMessage>(prev: readonly T[], page: readonly T[], deletedIds?: ReadonlySet<string>): T[] {
  const byId = new Map<string, T>()
  for (const m of prev) byId.set(m.id, m)
  for (const m of page) byId.set(m.id, m)
  if (deletedIds) deletedIds.forEach(id => byId.delete(id))
  return sortMessagesAscending(Array.from(byId.values()))
}

export interface SummaryMessage {
  topic?: string | null
  created_at: string
  sender_type: string
  message: string
  read_at?: string | null
  deleted_at?: string | null
}

const isChatEventNote = (message: string): boolean => message.toLowerCase().includes('<!-- chat-event:')
const isPaymentReceivedNote = (message: string): boolean => /<!--\s*chat-event:\s*kind=payment_received/i.test(message)

/**
 * A message that arrives live (staff screen): keep the topic list current without a refetch — a new topic gets its tab, the
 * topic's newest-activity time moves forward, and an unread client/system message raises that topic's unread count. Same rules as
 * the server: a deleted message changes nothing, a "payment received" note never counts as activity, a chat-event note counts as
 * activity but never as unread (those belong to What's New). Returns the list unchanged when there is none yet (nothing to patch).
 */
export function applyMessageToSummary(
  prev: readonly TopicSummaryEntry[] | null | undefined,
  msg: SummaryMessage,
): TopicSummaryEntry[] | null | undefined {
  if (!prev) return prev as null | undefined
  if (msg.deleted_at || isPaymentReceivedNote(msg.message)) return prev as TopicSummaryEntry[]
  const key = topicKeyOf(msg.topic)
  const next = prev.map(e => ({ ...e }))
  let entry = next.find(e => e.topic === key)
  if (!entry) { entry = { topic: key, lastAt: null, unread: 0 }; next.push(entry) }
  if (entry.lastAt === null || parseTimestamp(msg.created_at) > parseTimestamp(entry.lastAt)) entry.lastAt = msg.created_at
  if (msg.sender_type !== 'admin' && !msg.read_at && !isChatEventNote(msg.message)) {
    entry.unread += 1
    if (!entry.lastUnreadAt || parseTimestamp(msg.created_at) > parseTimestamp(entry.lastUnreadAt)) entry.lastUnreadAt = msg.created_at
  }
  return next
}

/**
 * A tab's FIRST page was refetched (poll, reply, wake, reconnect). It is the newest `pageSize` messages of the topic, so it can start
 * later than before; the rows it no longer covers must not be thrown away (a reader who loaded history, then sent one message, would
 * lose it all). They are FOLDED into the older pages instead, so the tab's pages stay one unbroken run:
 *  - no overlap between the old and the new first page (more than a page of new messages arrived): there is a real hole between them —
 *    the older pages are dropped and `dropped` is true (the next "Older messages" click reloads from the new start);
 *  - a short new first page (< pageSize): the whole topic fits in it, so nothing older exists — older pages are cleared (anything there
 *    was deleted);
 *  - otherwise: old first-page rows older than the new page's oldest (and not in it) join the older pages. Rows INSIDE the new page's
 *    range that are missing from it were deleted and simply do not come back.
 */
export function foldFirstPage<T extends TopicViewMessage>(args: {
  prevFirst: readonly T[] | null | undefined
  nextFirst: readonly T[]
  older: readonly T[]
  pageSize: number
}): { older: T[]; dropped: boolean } {
  const { prevFirst, nextFirst, older, pageSize } = args
  if (nextFirst.length < pageSize) return { older: [], dropped: false }
  if (!prevFirst || prevFirst.length === 0) return { older: [...older], dropped: false }
  const nextIds = new Set(nextFirst.map(m => m.id))
  if (!prevFirst.some(m => nextIds.has(m.id))) return { older: [], dropped: true }
  const newOldest = oldestCreatedAt(nextFirst)
  const cut = newOldest === null ? Infinity : parseTimestamp(newOldest)
  const displaced = prevFirst.filter(m => !nextIds.has(m.id) && parseTimestamp(m.created_at) < cut)
  return { older: mergeTabPages(older, displaced), dropped: false }
}
