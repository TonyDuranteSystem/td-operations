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

/**
 * "Don't show this tour again" — remembered per signed-in person, per browser (same storage approach as the WhatsApp
 * tour). The tour comes back on every visit until the person ticks that box; there is no "seen once" memory
 * (Antonio, 2026-10-06: "the tour must appear until the user checks a box, then don't show it again").
 */
export function replyTourDismissedKey(userId: string): string {
  return `reply-tour-dismissed:${userId}`
}

export interface TourStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Has this person ticked "Don't show again" on this browser? Never throws (blocked storage = not dismissed). */
export function isReplyTourDismissed(storage: TourStorage | null, userId: string): boolean {
  try {
    return storage?.getItem(replyTourDismissedKey(userId)) === '1'
  } catch {
    return false
  }
}

/** Tick / untick the box. Returns whether the choice was stored (false = storage blocked, so it cannot stick). */
export function setReplyTourDismissed(storage: TourStorage | null, userId: string, dismissed: boolean): boolean {
  try {
    if (!storage) return false
    if (dismissed) storage.setItem(replyTourDismissedKey(userId), '1')
    else storage.removeItem(replyTourDismissedKey(userId))
    return true
  } catch {
    return false
  }
}

// Once per page load: the tour starts by itself on the first email opened after the inbox loads, not again on every
// email clicked after that. Module-level on purpose (like the tour lock): a reload, or a new visit, starts it again.
let shownThisLoad = false
export function wasReplyTourShownThisLoad(): boolean {
  return shownThisLoad
}
export function markReplyTourShownThisLoad(): void {
  shownThisLoad = true
}
/** Test helper — never called by the app. */
export function __resetReplyTourShown(): void {
  shownThisLoad = false
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
  /** This person ticked "Don't show this tour again" on this browser. */
  dismissed: boolean
  /** It already started by itself during this page load (so not again on every email clicked). */
  shownThisLoad: boolean
  /** The tab is on screen (a background tab would burn the one-time flag with nobody watching). */
  tabVisible: boolean
  /** The cursor is already in the reply box — they are writing; do not take the focus away. */
  replyBoxBusy: boolean
}

/**
 * Starts by itself on the first email opened in a page load, on a normal wide screen, until the person ticks
 * "Don't show this tour again" — never over something else.
 */
export function shouldAutoStartReplyTour(c: AutoStartContext): boolean {
  return (
    !!c.userId &&
    c.emailThreadOpen &&
    !c.framedOrPopout &&
    !c.anotherTourActive &&
    c.wideScreen &&
    !c.dismissed &&
    !c.shownThisLoad &&
    c.tabVisible &&
    !c.replyBoxBusy
  )
}
