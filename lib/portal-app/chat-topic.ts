/**
 * Client iPhone app — which chat topic opens, and the number on the Topic button (pure; dev job 056a70d0, Step 3b).
 *
 * Topic keys are the chat's own: '' is General (untagged messages), anything else is the topic's name.
 *
 * Opening rule. The WEBSITE opens General first; if General has nothing unread it opens the topic with the most unread (ties: the most
 * recently active). That rule is kept exactly as it was. The APP uses Antonio's rule (8 Nov 2026): open on the topic of the NEWEST unread
 * answer from the team, wherever it was sent (General included). Both only decide where the chat OPENS; a topic the client picked,
 * or a link's topic, always wins (the caller checks that first, as before).
 */
import { parseTimestamp } from '@/lib/portal/chat-refresh-merge'

export interface TopicMessage {
  topic?: string | null
  sender_type?: string | null
  read_at?: string | null
  client_kept_unread?: boolean | null
  deleted_at?: string | null
  created_at: string
}

/** An answer from the team the client has not read yet (a message they marked "unread" again counts; a deleted one never does, R100). */
export function isUnreadAnswer(m: TopicMessage): boolean {
  if (m.sender_type !== 'admin' || m.deleted_at) return false
  return !m.read_at || !!m.client_kept_unread
}

/** The topic of the newest unread answer among the loaded messages: '' = General, null = nothing unread is loaded. */
export function newestUnreadTopic(messages: readonly TopicMessage[]): string | null {
  let best: TopicMessage | null = null
  let bestAt = -1
  for (const m of messages) {
    if (!isUnreadAnswer(m)) continue
    const at = parseTimestamp(m.created_at)
    if (at >= bestAt) { best = m; bestAt = at }
  }
  return best ? (best.topic ?? '') : null
}

/**
 * Where the chat opens by itself: a topic name to open, or null to stay on General.
 * `serverUnread` is the server's unread count per topic (covers messages older than the loaded page); `messages` are the loaded ones.
 */
export function chooseOpeningTopic(opts: {
  serverUnread: Readonly<Record<string, number>>
  messages: readonly TopicMessage[]
  /** true inside the client app: open on the newest unread answer's topic. */
  newestAnswerRule: boolean
}): string | null {
  const { serverUnread, messages } = opts
  if (opts.newestAnswerRule) {
    const newest = newestUnreadTopic(messages)
    if (newest === '') return null
    if (newest) return newest
    // nothing unread among the loaded messages: fall through to the server's counts
  }
  if ((serverUnread[''] ?? 0) > 0) return null
  const candidates = Object.entries(serverUnread).filter(([k, n]) => k && n > 0)
  if (candidates.length === 0) return null
  const lastAt = (k: string) => Math.max(0, ...messages.filter(m => (m.topic ?? '') === k).map(m => parseTimestamp(m.created_at)))
  candidates.sort((a, b) => (b[1] - a[1]) || (lastAt(b[0]) - lastAt(a[0])))
  return candidates[0][0]
}

/** The red number on the Topic button: unread answers in every topic EXCEPT the one that is open. */
export function unreadInOtherTopics(unreadByTopic: Readonly<Record<string, number>>, activeTopic: string | null): number {
  const active = activeTopic ?? ''
  let sum = 0
  for (const [k, n] of Object.entries(unreadByTopic)) if (k !== active && n > 0) sum += n
  return sum
}
