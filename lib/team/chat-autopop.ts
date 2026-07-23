/**
 * Floating chat window — should an incoming message open it?
 *
 * Pure, because every bug the council found in this feature lives in exactly
 * this decision and none of them is reachable from a unit test if the logic is
 * buried in an effect. Each rule below is a specific failure that was found:
 *
 *  - OWN MESSAGE, id still resolving. The current user id is fetched
 *    asynchronously. During that window a naive "not my message → open" test
 *    compares against null and passes, so a message you sent from another tab
 *    pops a window at you. Unknown identity means DO NOT open.
 *  - NOT MY CONVERSATION. Only direct messages to me, or a thread I am a
 *    participant of, may open the window. Channel chatter must never.
 *  - UNKNOWN THREAD. The set of my DM threads is refreshed on a timer, so the
 *    FIRST message of a brand-new conversation is not in it — and realtime
 *    replays nothing, so that message would be lost forever. We return
 *    'refresh' rather than false: the caller re-fetches the thread list once and
 *    asks again. This is the difference between "not for me" and "I don't know
 *    yet", which the existing notification listener conflates.
 *  - BUSY. Popping over a modal steals focus mid-typing; popping under one is
 *    invisible while still counting as shown. Either way the user loses. If an
 *    overlay is up or the user is typing, hold.
 *  - DESKTOP ONLY. At ~380px there is nowhere for a window to go, and Antonio
 *    runs the whole CRM as a phone app. Mobile gets a badge, never a pop.
 *  - QUIET. An explicit user choice outranks everything except correctness.
 *  - ALREADY THERE. If the window is already open on that person, the message
 *    just lands — re-popping would yank the scroll position out from under
 *    someone reading history.
 *  - ON THE CHAT PAGE. The full Team Chat page is the handler there; a window
 *    on top of it would double-render and double-mark-read.
 */

export type AutoPopDecision =
  /** Open the window on this thread. */
  | 'open'
  /** Do nothing. */
  | 'ignore'
  /** Thread unrecognised — refresh the thread list and ask again once. */
  | 'refresh'

export interface AutoPopInput {
  /** Viewport is desktop-sized (the caller decides the breakpoint). */
  isDesktop: boolean
  /** The user has switched auto-open off. */
  quiet: boolean
  /** Current pathname, so we can stand down where another surface owns the job. */
  pathname: string
  /** Who sent it. */
  senderId: string | null | undefined
  /** Who I am — null while still resolving. */
  myId: string | null | undefined
  /** The thread the message landed in. */
  threadId: string | null | undefined
  /** Thread ids known to be my DMs. */
  myDmThreadIds: ReadonlySet<string>
  /** Thread ids of client conversations I take part in. */
  myConversationThreadIds?: ReadonlySet<string>
  /** True if the message @-mentions me (mentions win over thread membership). */
  mentionsMe?: boolean
  /** An overlay (modal, drawer, command palette) is currently up. */
  overlayOpen: boolean
  /** The user is typing into something right now. */
  isTyping: boolean
  /** The window is already open, and on which thread. */
  openThreadId?: string | null
  /** The window is open but minimized to the pill. */
  minimized?: boolean
  /**
   * Set once the caller has already refreshed the thread list for this message,
   * so a genuinely-unknown thread cannot loop between 'refresh' and 'refresh'.
   */
  alreadyRefreshed?: boolean
}

/** Pathnames that own the incoming-message job themselves. */
const SURFACES_THAT_HANDLE_THEMSELVES = ['/team-chat']

export function decideAutoPop(input: AutoPopInput): AutoPopDecision {
  const {
    isDesktop, quiet, pathname, senderId, myId, threadId,
    myDmThreadIds, myConversationThreadIds, mentionsMe,
    overlayOpen, isTyping, openThreadId, minimized, alreadyRefreshed,
  } = input

  // Identity unknown → never guess. A null myId must not read as "not mine".
  if (!myId) return 'ignore'
  // My own message, echoed back from another tab.
  if (senderId && senderId === myId) return 'ignore'
  if (!threadId) return 'ignore'

  // The full chat page handles its own messages. NOTE: deliberately NOT
  // suppressed on /portal-chats — the existing notification listener bails
  // there, which is why a DM arriving while Antonio works in Portal Chats
  // currently produces no signal at all.
  if (SURFACES_THAT_HANDLE_THEMSELVES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return 'ignore'
  }

  // Is this message for me at all?
  const isMine =
    !!mentionsMe ||
    myDmThreadIds.has(threadId) ||
    !!myConversationThreadIds?.has(threadId)
  if (!isMine) {
    // Unknown thread — could be a brand-new DM whose id we have not learned yet.
    // Ask the caller to refresh once before writing the message off.
    return alreadyRefreshed ? 'ignore' : 'refresh'
  }

  // From here the message IS for me. Everything below is about whether now is a
  // good moment to put a window on screen — the message is not lost either way,
  // the badge still moves.
  if (quiet) return 'ignore'
  if (!isDesktop) return 'ignore'
  if (overlayOpen || isTyping) return 'ignore'
  // Already looking at this conversation — let it land in place.
  if (openThreadId === threadId && !minimized) return 'ignore'

  return 'open'
}
