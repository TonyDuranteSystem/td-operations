/**
 * Open the floating chat on a specific conversation, from anywhere.
 *
 * The event name lives HERE, once — the dispatcher (a note's "Discuss" button)
 * and the receiver (the floating chat) both import it, so the string can't drift
 * apart the way a repeated literal would.
 *
 * HOW THE FALLBACK WORKS: the event is cancelable. The floating chat calls
 * preventDefault ONLY when it can actually show the thread. `dispatchEvent`
 * returns false when preventDefault was called, so `requestOpenTeamChat` returns
 * TRUE = handled. When it returns FALSE — the chat window is switched off (not
 * mounted, no listener) or the user is already on the full Team Chat page (where
 * the floating window renders nothing) — the caller navigates to the full page
 * instead. Either way the button always does something.
 */

export const OPEN_TEAM_CHAT_EVENT = 'td-open-team-chat'

export interface OpenTeamChatDetail {
  threadId: string
  /** Pre-fill the composer with this line (the human still sends it). */
  draft?: string
}

/** Ask the floating chat to open a thread. Returns true if it handled it. */
export function requestOpenTeamChat(detail: OpenTeamChatDetail): boolean {
  if (typeof document === 'undefined') return false
  const evt = new CustomEvent(OPEN_TEAM_CHAT_EVENT, { detail, cancelable: true })
  return document.dispatchEvent(evt) === false // false = a handler preventDefault'd it
}
