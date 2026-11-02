/**
 * The outbox rules (pure, unit-tested): a chat message that cannot be delivered right away is kept on the phone and sent again later. This file holds the decisions
 * (when to try again, what a failed answer means, what the waiting message looks like in the chat); `lib/talk/outbox.ts` does the storing and the sending.
 */
import type { TalkMessage, TalkReplyPreview } from '@/lib/talk/chat-model'

/** How a queued message is sent: TD Talk's own thread route, or a TD Marketing chat (a lead, or a team conversation) with its address and lane query. */
export type OutboxTarget =
  | { kind: 'talk'; threadId: string }
  | { kind: 'lead'; api: string; id: string; laneQs: string }

export interface OutboxFile { name: string; type: string; blob: Blob }

export interface OutboxItem {
  /** The message's own id: also what the server stores it under, so a second try can never post it twice. */
  id: string
  /** Which chat it belongs to (one string per open conversation). */
  scope: string
  target: OutboxTarget
  senderId: string
  senderName: string
  text: string
  files: OutboxFile[]
  replyToId: string | null
  replyPreview: TalkReplyPreview | null
  createdAt: string
  /** The attachments already stored on the server, by file position: a second try does not upload them again. */
  uploaded: unknown[]
  state: 'pending' | 'failed'
  error?: string
  /** Failed tries so far (drives the waiting wording and the pause between tries). */
  attempts: number
}

/** Pause before the next try after `failedRounds` rounds in a row that found no connection: 3 s, 6 s, 12 s … never more than 30 s. */
export function retryDelayMs(failedRounds: number): number {
  const n = Number.isFinite(failedRounds) ? Math.max(0, Math.floor(failedRounds)) : 0
  return Math.min(30_000, 3_000 * 2 ** Math.min(n, 6))
}

/** A server answer that sending again will not change (a "no" about the message itself). Busy, slow, overloaded or a dropped line may pass; so may "too many requests". */
export function isPermanentStatus(status: number): boolean {
  if (status === 408 || status === 429) return false
  return status >= 400 && status < 500
}

/** Oldest first: messages go out in the order they were written. */
export function sendOrder(items: readonly OutboxItem[]): OutboxItem[] {
  return [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
}

/** The waiting message as the chat shows it. Never has attachments of its own (the files are still on the phone); `local` says what to draw. */
export function localMessage(item: OutboxItem): TalkMessage {
  const state: 'sending' | 'waiting' | 'failed' = item.state === 'failed' ? 'failed' : item.attempts > 0 ? 'waiting' : 'sending'
  return {
    id: item.id,
    sender_id: item.senderId,
    sender_name: item.senderName,
    message: item.text,
    created_at: item.createdAt,
    attachments: null,
    reply_to_id: item.replyToId,
    reply_to_preview: item.replyPreview,
    local: { state, error: item.error, files: item.files.map(f => ({ name: f.name, voice: f.type.startsWith('audio/') })) },
  }
}

/** The chat's own list plus its waiting messages — a waiting message disappears the moment the server's copy (same id) is in the list. */
export function withOutbox(messages: readonly TalkMessage[], waiting: readonly TalkMessage[]): TalkMessage[] {
  if (waiting.length === 0) return messages as TalkMessage[]
  const have = new Set(messages.map(m => m.id))
  return [...messages, ...waiting.filter(w => !have.has(w.id))]
}
