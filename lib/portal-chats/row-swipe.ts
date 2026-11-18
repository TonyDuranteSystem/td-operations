/**
 * Swipe on a conversation row of the staff Portal Chats list (phone, 18 Nov 2026). Pure rules only — the touch wiring lives in
 * `components/portal-chats/swipe-row.tsx`.
 *  - swipe RIGHT reveals the left pair of buttons (read/unread, pin); swipe LEFT reveals the right pair (note, copy link)
 *  - a mostly-vertical drag is a scroll and never moves the row
 */
export type SwipeState = 'closed' | 'left' | 'right'

/** Width of one revealed button, and the drag needed to snap the row open (px). */
export const SWIPE_BUTTON_PX = 72
export const SWIPE_BUTTONS_PER_SIDE = 2
export const SWIPE_OPEN_PX = SWIPE_BUTTON_PX * SWIPE_BUTTONS_PER_SIDE
const SWIPE_START_PX = 10
const SWIPE_SNAP_PX = 48

/** True when a drag is clearly sideways (not a scroll). */
export function isHorizontalDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_START_PX && Math.abs(dx) > Math.abs(dy) * 1.5
}

/** Where the row sits while the finger is down: the resting offset plus the drag, held inside the revealed width. */
export function rowOffset(state: SwipeState, dx: number): number {
  const rest = state === 'right' ? SWIPE_OPEN_PX : state === 'left' ? -SWIPE_OPEN_PX : 0
  return Math.max(-SWIPE_OPEN_PX, Math.min(SWIPE_OPEN_PX, rest + dx))
}

/** Where the row settles when the finger lifts. */
export function settleState(state: SwipeState, dx: number): SwipeState {
  const offset = rowOffset(state, dx)
  if (offset >= SWIPE_SNAP_PX) return 'right'
  if (offset <= -SWIPE_SNAP_PX) return 'left'
  return 'closed'
}

/** Which side's buttons are showing at this offset. */
export function revealedSide(offset: number): 'left' | 'right' | null {
  if (offset > 0) return 'left'
  if (offset < 0) return 'right'
  return null
}
