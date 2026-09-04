/**
 * Capture/Share feature — pure geometry for the mark-up tools. The actual
 * drawing (canvas pixel operations) lives in the component, since that part
 * needs a real browser canvas to test meaningfully; this file holds the math
 * that's worth pinning with a unit test on its own.
 */
import type { Point } from './selection'

export type MarkupTool = 'draw' | 'arrow' | 'text' | 'redact'

/** Tools offered, in display order — deliberately NOT a plain "box" tool: a
 *  box that looks like the redact tool but isn't would be a real trap (UX
 *  review, 2026-09-04) — so there is exactly one tool that draws a filled
 *  rectangle, and it is always the destructive one. */
export const MARKUP_TOOLS: MarkupTool[] = ['draw', 'arrow', 'text', 'redact']

/**
 * The two wing-tip points of an arrowhead pointing from `from` toward `to`.
 * Degenerates gracefully (returns `to` twice) for a zero-length line rather
 * than producing NaN, since a user can release a tap with no movement.
 */
export function arrowHeadPoints(from: Point, to: Point, headLength = 14, headAngleDeg = 28): [Point, Point] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lineAngle = Math.atan2(dy, dx)
  if (!Number.isFinite(lineAngle)) return [to, to]

  const headAngle = (headAngleDeg * Math.PI) / 180
  const left: Point = {
    x: to.x - headLength * Math.cos(lineAngle - headAngle),
    y: to.y - headLength * Math.sin(lineAngle - headAngle),
  }
  const right: Point = {
    x: to.x - headLength * Math.cos(lineAngle + headAngle),
    y: to.y - headLength * Math.sin(lineAngle + headAngle),
  }
  return [left, right]
}
