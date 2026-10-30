/**
 * TD Talk — the voice for a message the live connection missed (pure; Antonio, 30 Oct 2026: "if TD Talk is open in a page and I switch away, I don't receive the voice").
 * Chrome slows or cuts the live connection of a tab that is not on screen, so the page also looks at the chat list every 30 seconds and when it comes back to the screen:
 * a direct or group chat whose unread number went UP since the last look got a new message. The live connection and this look must never both speak for the same message —
 * `suppress` holds the chats the live connection already announced since the last look.
 */
import { TALK_FEATURE_PHRASE, isImplementationChat } from '@/lib/talk/voice-alert'

export interface CatchUpThread {
  id: string
  thread_type?: string | null
  unread_count?: number | string | null
  last_sender_name?: string | null
  label?: string | null
}

export const MANY_PHRASE = 'New messages in TD Talk'

const isChat = (t: CatchUpThread) => t.thread_type === 'dm' || t.thread_type === 'group'
/** The list sends the unread count as a number or a numeric string (a database bigint). */
const unreadOf = (t: CatchUpThread): number => { const n = Number(t.unread_count ?? 0); return Number.isFinite(n) && n > 0 ? n : 0 }

/** The unread number of every direct and group chat, by id. */
export function unreadBaseline(threads: readonly CatchUpThread[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of threads) if (isChat(t)) out[t.id] = unreadOf(t)
  return out
}

/**
 * The chats that got a new message since `prev`: unread went up. No `prev` (the first look) = nothing, it only sets the starting point. A chat that is open on screen or that the live
 * connection already announced is left out.
 */
export function threadsWithNewUnread(
  prev: Readonly<Record<string, number>> | null,
  threads: readonly CatchUpThread[],
  skip: { openThreadId?: string | null; suppress?: ReadonlySet<string> } = {},
): CatchUpThread[] {
  if (!prev) return []
  return threads.filter(t => isChat(t)
    && t.id !== skip.openThreadId
    && !skip.suppress?.has(t.id)
    && unreadOf(t) > (prev[t.id] ?? 0))
}

export interface CatchUpSpeech { senderName: string | null; identity: string; override?: string }

/** What to say for the chats found: one chat = what the live connection would have said; several = one line, never a stream. */
export function catchUpSpeech(fresh: readonly CatchUpThread[]): CatchUpSpeech | null {
  if (fresh.length === 0) return null
  if (fresh.length > 1) return { senderName: null, identity: 'many', override: MANY_PHRASE }
  const t = fresh[0]
  if (t.thread_type === 'group' && isImplementationChat(t.label)) return { senderName: null, identity: t.id, override: TALK_FEATURE_PHRASE }
  return { senderName: t.last_sender_name ?? null, identity: t.id }
}
