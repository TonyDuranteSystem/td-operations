/**
 * Offline edit / delete / react for TD Talk (Antonio, 3 Nov 2026 audit: only SENDING survived a lost connection; changing a message you already sent failed with an error and was thrown away).
 * A change made without a connection is kept on the phone and applied as soon as it can be. These are the pure rules (unit-tested); `outbox-actions.ts` stores and sends.
 * The screen shows a queued change at once by laying it OVER the messages the server gave (`overlayActions`) — nothing on screen is faked in the real list, so when the server
 * answers (or says no) the truth simply replaces the overlay.
 */
import type { TalkMessage, TalkReaction } from '@/lib/talk/chat-model'
import { isPermanentStatus } from '@/lib/talk/outbox-rules'

interface ActionBase {
  /** Own id (a uuid): what the browser stores it under. */
  id: string
  messageId: string
  /** The chat the message is in (the screen only draws the open chat's queued changes). */
  threadId: string
  senderId: string
  createdAt: string
  /** Failed tries so far (drives the pause between tries). */
  attempts: number
  /** How many times the SERVER itself answered with an error (5xx) for this change: after `SERVER_ERROR_LIMIT` the change is given up so one broken change cannot block the queue for ever. */
  serverErrors?: number
}

export type ChatAction =
  | (ActionBase & { kind: 'edit'; text: string })
  | (ActionBase & { kind: 'delete' })
  /** `on` = the state the person wants (set, not toggle): sending it twice can never flip it back. */
  | (ActionBase & { kind: 'react'; emoji: string; on: boolean })

/**
 * Adds a change to the waiting ones. One message never carries a pile of contradicting changes:
 * a delete wins over everything else on that message; a newer edit replaces an older edit; the latest wish for the same reaction replaces the earlier one.
 */
export function addAction(waiting: readonly ChatAction[], next: ChatAction): ChatAction[] {
  const sameMessage = waiting.filter(a => a.messageId === next.messageId)
  const others = waiting.filter(a => a.messageId !== next.messageId)
  if (sameMessage.some(a => a.kind === 'delete')) return [...waiting] // already going to be deleted: nothing else matters
  if (next.kind === 'delete') return [...others, next]
  if (next.kind === 'edit') return [...others, ...sameMessage.filter(a => a.kind !== 'edit'), next]
  return [...others, ...sameMessage.filter(a => !(a.kind === 'react' && a.emoji === next.emoji)), next]
}

/** Oldest first: changes are applied in the order they were made. */
export function actionOrder(list: readonly ChatAction[]): ChatAction[] {
  return [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
}

/** A message with the waiting changes laid over it, and whether anything is waiting for it. */
export function overlayActions(messages: readonly TalkMessage[], waiting: readonly ChatAction[], me: { id: string; name: string } | null): TalkMessage[] {
  if (waiting.length === 0 || !me) return messages as TalkMessage[]
  const byMessage = new Map<string, ChatAction[]>()
  for (const a of actionOrder(waiting)) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a])
  return messages.map(m => {
    const list = byMessage.get(m.id)
    if (!list) return m
    let out: TalkMessage = { ...m, pending: true }
    for (const a of list) {
      if (a.kind === 'delete') out = { ...out, deleted_at: a.createdAt }
      else if (a.kind === 'edit') out = { ...out, message: a.text, edited_at: a.createdAt }
      else {
        const without = (out.reactions ?? []).filter((r: TalkReaction) => !(r.emoji === a.emoji && r.reactor_id === me.id))
        out = { ...out, reactions: a.on ? [...without, { emoji: a.emoji, reactor_id: me.id, reactor_name: me.name }] : without }
      }
    }
    return out
  })
}

/** Does this person currently have this reaction on the message (as drawn, including a waiting change)? */
export function hasMyReaction(m: Pick<TalkMessage, 'reactions'>, emoji: string, meId: string): boolean {
  return (m.reactions ?? []).some(r => r.emoji === emoji && r.reactor_id === meId)
}

/** The words for a change the server refused, for the message shown to the person. */
export function actionVerb(a: Pick<ChatAction, 'kind'>): string {
  return a.kind === 'edit' ? 'save your edit' : a.kind === 'delete' ? 'delete the message' : 'save your reaction'
}

/** After this many server errors (5xx) for ONE change it is dropped and the person is told (a lost connection never counts). */
export const SERVER_ERROR_LIMIT = 5

export type AnswerClass =
  | { kind: 'done' }
  | { kind: 'retry'; server: boolean; error: string }
  | { kind: 'refused'; error: string }

/**
 * What the server's answer means for a kept change. Done = it is on the server. Retry = keep it and try again later (no connection, busy, slow, an expired sign-in — the change waits
 * until the person is signed in again — or an answer that is not the server's JSON, such as a Wi-Fi sign-in page). Refused = a real "no" about this change (not your message, gone, too long): drop it.
 * `body` is the parsed JSON, or null when the answer was not JSON.
 */
export function classifyAnswer(status: number, body: unknown): AnswerClass {
  const obj = body && typeof body === 'object' ? (body as { error?: unknown; code?: unknown }) : null
  const err = obj && typeof obj.error === 'string' ? obj.error : ''
  if (status >= 200 && status < 300) {
    return body === null || body === undefined ? { kind: 'retry', server: false, error: 'Unexpected answer.' } : { kind: 'done' }
  }
  if (status === 401 || obj?.code === 'SESSION_EXPIRED' || (status === 403 && err === 'Unauthorized')) return { kind: 'retry', server: false, error: err || 'Please sign in again.' }
  if (isPermanentStatus(status)) return { kind: 'refused', error: err || 'Please try again.' }
  return { kind: 'retry', server: status >= 500, error: err || 'Please try again.' }
}
