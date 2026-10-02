/**
 * Where a FastTooltip label goes, in viewport coordinates, for `position: fixed`.
 *
 * The label used to be absolutely positioned INSIDE its wrapper. Inside a
 * scroll/clip box (e.g. a table wrapped in `overflow-x-auto`, which CSS also
 * turns into overflow-y:auto) a label under the bottom row spilled past the
 * box, a scrollbar appeared, the layout shifted away from the cursor, the
 * label hid, the scrollbar vanished, the cursor was back on the button — an
 * endless flicker (Team Management, Oct 2026). A fixed, body-level label takes
 * no part in any container's layout, so it can't cause that.
 */
export type TooltipAlign = 'left' | 'right' | 'center'

export interface TooltipRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
}

export interface TooltipPosition {
  top: number
  left: number
  /** translateX applied so the label hangs off the anchor edge correctly. */
  translateX: '0' | '-100%' | '-50%'
  /** '-100%' when the label sits ABOVE the anchor (no room below). */
  translateY: '0' | '-100%'
}

const GAP_PX = 4
/** Approximate label height — a one-line text-xs label with padding. */
const LABEL_HEIGHT_PX = 28

export function tooltipPosition(
  rect: TooltipRect,
  align: TooltipAlign,
  viewportHeight?: number,
): TooltipPosition {
  const noRoomBelow =
    viewportHeight !== undefined && rect.bottom + GAP_PX + LABEL_HEIGHT_PX > viewportHeight
  const top = noRoomBelow ? rect.top - GAP_PX : rect.bottom + GAP_PX
  const translateY = noRoomBelow ? '-100%' : '0'
  if (align === 'left') return { top, left: rect.left, translateX: '0', translateY }
  if (align === 'center') return { top, left: rect.left + rect.width / 2, translateX: '-50%', translateY }
  return { top, left: rect.right, translateX: '-100%', translateY }
}
