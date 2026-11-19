/**
 * A TD Talk message link (`?thread=<chat>&message=<id>`) waiting for its chat to open (Antonio, 2026-11-17: a tapped lock-screen alert opened the app but
 * did not go to the message). The link is kept WITH its chat, so a tap while another chat is open waits for the right chat instead of jumping inside the
 * wrong one, and it is forgotten after a while so an old link can never jump somewhere much later. Pure, so the rules are unit-tested.
 */
export interface PendingJump {
  /** The chat the message is in (null = the link named none: whichever chat opens). */
  threadId: string | null
  messageId: string
  /** When the link arrived (ms since 1970). */
  at: number
}

/** An alert link that never finds its chat is forgotten after this long. */
export const PENDING_JUMP_MAX_AGE_MS = 30_000

/** The link in a page address (`window.location.search`), if it has a message. */
export function pendingJumpFromSearch(search: string, now: number): PendingJump | null {
  const q = new URLSearchParams(search)
  const messageId = q.get('message')
  return messageId ? { threadId: q.get('thread'), messageId, at: now } : null
}

export type JumpDecision = 'none' | 'wait' | 'drop' | 'go'

/**
 * none = nothing is waiting; wait = not yet (the chat is loading, empty, or not the link's chat); drop = too old, forget it; go = scroll to the message now.
 * While another chat is open (or only just chosen) its messages are not the link's chat's: `selectedId` must be the link's chat.
 */
export function decideJump(p: PendingJump | null, ctx: { now: number; loadingMsgs: boolean; messageCount: number; selectedId: string | null }): JumpDecision {
  if (!p) return 'none'
  if (ctx.now - p.at > PENDING_JUMP_MAX_AGE_MS) return 'drop'
  if (ctx.loadingMsgs || ctx.messageCount === 0) return 'wait'
  if (p.threadId && ctx.selectedId !== p.threadId) return 'wait'
  return 'go'
}
