/**
 * The email-reply tour's rules (dev job 10b8dfce) — pure, so what the tour does and when it starts is pinned in tests.
 *
 * The tour (components/inbox/reply-tour.tsx, react-joyride, the same pattern as the WhatsApp tour) walks a person
 * through the new reply box: the writing box, the slim toolbar, the AI button, Expand, the pop-up's full toolbar,
 * the "open by default" tick-box, and the unsent-reply safety net. Some steps only exist while the reply box is
 * being written in, and some only inside the pop-up; the tour asks the reply box to get into the right state
 * through a window event (the tour and the reply box live in different parts of the inbox and share no props).
 */

export const REPLY_TOUR_EVENT = 'td-reply-tour'

/** 'release' = the tour is over: stop holding the reply box in writing mode. */
export type ReplyTourAction = 'compose' | 'expand' | 'collapse' | 'release'

export interface ReplyTourStepMeta {
  id: string
  /** The step's target only exists once the reply box is being written in (the slim toolbar shows only then). */
  needsComposing: boolean
  /** The step's target lives inside the Expand pop-up. */
  inPopup: boolean
}

export const REPLY_TOUR_STEPS: readonly ReplyTourStepMeta[] = [
  { id: 'box', needsComposing: false, inPopup: false },
  { id: 'toolbar', needsComposing: true, inPopup: false },
  { id: 'ai', needsComposing: false, inPopup: false },
  { id: 'expand', needsComposing: false, inPopup: false },
  { id: 'popup-toolbar', needsComposing: true, inPopup: true },
  { id: 'popup-default', needsComposing: true, inPopup: true },
  { id: 'safety', needsComposing: true, inPopup: true },
]

/** Remembered per signed-in person, per browser — same approach as the WhatsApp tour. */
export function replyTourSeenKey(userId: string): string {
  return `reply-tour-seen:${userId}`
}

/**
 * What the reply box must do when the tour moves from one step to another (indexes into REPLY_TOUR_STEPS), or null.
 * Crossing into the pop-up opens it, crossing out closes it (the text is kept either way), and reaching the first
 * step that needs the box "in use" puts it in writing mode. -1 as `from` means the tour is just starting.
 */
export function transitionAction(from: number, to: number): ReplyTourAction | null {
  const target = REPLY_TOUR_STEPS[to]
  if (!target) return null
  const source = from >= 0 ? REPLY_TOUR_STEPS[from] : undefined
  if (target.inPopup && !source?.inPopup) return 'expand'
  if (!target.inPopup && source?.inPopup) return 'collapse'
  if (target.needsComposing && !source?.needsComposing) return 'compose'
  return null
}

/** When the tour ends (finished or skipped) from a step inside the pop-up, the pop-up is closed again. */
export function endAction(lastIndex: number): ReplyTourAction | null {
  return REPLY_TOUR_STEPS[lastIndex]?.inPopup ? 'collapse' : null
}

export interface AutoStartContext {
  userId: string | undefined
  /** A Gmail thread is open, so the reply box is on screen. */
  emailThreadOpen: boolean
  /** A floating window's small frame, or a pop-out browser window. */
  framedOrPopout: boolean
  /** Another guided tour (WhatsApp, windows) is on screen. */
  anotherTourActive: boolean
  /** Wide enough for the two-pane pop-up. */
  wideScreen: boolean
  /** This person has already been shown it on this browser. */
  alreadySeen: boolean
}

/** Starts by itself once, the first time a person has an email open on a normal screen — never over something else. */
export function shouldAutoStartReplyTour(c: AutoStartContext): boolean {
  return !!c.userId && c.emailThreadOpen && !c.framedOrPopout && !c.anotherTourActive && c.wideScreen && !c.alreadySeen
}
