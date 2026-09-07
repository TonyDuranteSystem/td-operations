/**
 * Capture/Share feature — pure rectangle math for the tap-two-corners area
 * selector (Antonio, 2026-09-04: tap one corner then the other, not a drag —
 * a continuous drag fights normal page scrolling on the phone, the same
 * gesture-conflict class this codebase has already had to build custom fixes
 * for twice: lib/ui/draggable-fab.ts's tap-vs-drag threshold, and the sticky
 * notes layer mounting outside <main> specifically to avoid fighting
 * pull-to-refresh).
 */

export interface Point {
  x: number
  y: number
}

export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

/** Below this, a "selection" is almost certainly an accidental double-tap, not a real region. */
export const MIN_SELECTION_SIZE = 10

/**
 * Two taps, in either order/direction, into a normalized top-left rect.
 * Clamped to the given bounds (the viewport, or the scrollable page size).
 */
export function rectFromTwoPoints(a: Point, b: Point, bounds: { width: number; height: number }): CaptureRect {
  const x = Math.max(0, Math.min(a.x, b.x))
  const y = Math.max(0, Math.min(a.y, b.y))
  const rawWidth = Math.abs(a.x - b.x)
  const rawHeight = Math.abs(a.y - b.y)
  const width = Math.max(0, Math.min(rawWidth, bounds.width - x))
  const height = Math.max(0, Math.min(rawHeight, bounds.height - y))
  return { x, y, width, height }
}

/** Is this rect big enough to be a deliberate selection, not a stray tap? */
export function isSelectionLargeEnough(rect: CaptureRect): boolean {
  return rect.width >= MIN_SELECTION_SIZE && rect.height >= MIN_SELECTION_SIZE
}
