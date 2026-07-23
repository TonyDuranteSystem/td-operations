/**
 * Draggable floating buttons — the geometry, kept pure and testable.
 *
 * Shared by the green chat launcher and the amber notes pill. Antonio asked for
 * both to be movable on DESKTOP AND on the phone, because the two of them plus
 * the toast stack were sitting on top of the Attach and Send buttons of the
 * message composer — i.e. the phone could not answer a client.
 *
 * ⚠️ THIS DELIBERATELY REVERSES A DOCUMENTED DECISION. docs/systems/staff-notes.md
 * states "Mobile has no dragging" (2026-07-21). That was a reasonable call — drag
 * on touch fights the page scroll and turns fat-fingered taps into moves. Antonio
 * overruled it on 2026-07-23 for his own phone. The two hazards that decision was
 * avoiding are handled here explicitly (the tap threshold below, and the caller's
 * touch-action:none), so this is a considered reversal, not an oversight. Do not
 * silently revert it.
 *
 * Positions are viewport FRACTIONS, never pixels: a spot chosen on a 27" iMac
 * must still be on-screen in a 380px PWA. Each button stores its own position
 * under its own key, per device.
 */

export interface FabPos {
  /** Left edge as a fraction of viewport width (0..1). */
  x: number
  /** Top edge as a fraction of viewport height (0..1). */
  y: number
}

export interface FabBox {
  vw: number
  vh: number
  /** The button's measured width/height in px. */
  w: number
  h: number
}

/**
 * How far a pointer must travel before we treat the gesture as a DRAG.
 *
 * Below this it is a TAP and the button does its normal job. Without this, a
 * finger that wobbles two pixels while tapping would move the button instead of
 * opening the chat — the single most likely way touch-dragging ruins an
 * otherwise fine button. 8px is the common platform threshold; it is comfortably
 * below the ~44px touch target so it cannot swallow a deliberate press.
 */
export const FAB_DRAG_THRESHOLD_PX = 8

/** Did the pointer move far enough to count as a drag rather than a tap? */
export function isDragGesture(dx: number, dy: number, threshold = FAB_DRAG_THRESHOLD_PX): boolean {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  return Math.hypot(dx, dy) >= threshold
}

/**
 * Clamp a fractional position so the whole button stays on screen.
 *
 * The maximum comes from the MEASURED element, not a constant — a fixed cap is
 * how the notes layer ends up able to strand a card half off the right edge.
 * If the element is somehow larger than the viewport, pin to the corner rather
 * than allowing a negative offset.
 */
export function clampFabPos(pos: FabPos, box: Partial<FabBox> = {}): FabPos {
  return { x: clampAxis(pos?.x, box.vw, box.w), y: clampAxis(pos?.y, box.vh, box.h) }
}

function clampAxis(frac: unknown, viewport?: number, element?: number): number {
  const f = typeof frac === 'number' && Number.isFinite(frac) ? frac : 0
  let max = 1
  if (Number.isFinite(viewport) && (viewport as number) > 0 && Number.isFinite(element) && (element as number) > 0) {
    max = ((viewport as number) - (element as number)) / (viewport as number)
  }
  if (!Number.isFinite(max) || max < 0) max = 0
  return Math.min(Math.max(f, 0), Math.min(max, 1))
}

/**
 * Turn a stored value into a usable position, or null if there isn't one.
 *
 * null means "never moved" — the caller then uses its CSS default corner rather
 * than a hard-coded fraction, so the untouched button keeps its designed
 * placement and the responsive classes still apply.
 */
export function readStoredFabPos(raw: string | null | undefined): FabPos | null {
  if (raw == null || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { x, y } = parsed as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    if (typeof y !== 'number' || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

export function serializeFabPos(pos: FabPos): string {
  return JSON.stringify({ x: pos.x, y: pos.y })
}

/** Storage keys — one per button, so they never fight over a position. */
export const FAB_KEYS = {
  chat: 'td-fab-pos-chat-v1',
  notes: 'td-fab-pos-notes-v1',
} as const
