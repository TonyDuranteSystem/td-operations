/**
 * Team Workspace — resizable thread pane geometry.
 *
 * Pure so the clamping rules are unit-testable without a DOM (R086). The pane
 * is a fixed 384px column today; long replies wrap into a tall narrow strip
 * (Antonio 2026-07-18). Dragging the divider changes its width, and the choice
 * is remembered per browser.
 *
 * Two floors matter: the pane itself must stay readable, AND the channel stream
 * behind it must never be squeezed to nothing — so the max is derived from the
 * container, not a constant.
 */

/** Width the pane opens at before the user has ever dragged it (px). */
export const THREAD_PANE_DEFAULT_WIDTH = 384

/** Narrowest the thread pane may be dragged (px). */
export const THREAD_PANE_MIN_WIDTH = 320

/** Narrowest the channel stream beside it may be squeezed (px). */
export const THREAD_STREAM_MIN_WIDTH = 360

/** localStorage key holding the user's chosen width. */
export const THREAD_PANE_WIDTH_KEY = 'td-team-thread-pane-width'

/**
 * Clamp a desired pane width against both floors.
 *
 * `containerWidth` is the full width of the messages+pane row. A non-finite or
 * non-positive container (SSR, first paint before layout) means "unknown" — the
 * pane floor still applies, the stream floor is skipped rather than guessed.
 * When the container is genuinely too small to honour both floors, the pane
 * floor wins (the stream is hidden on mobile anyway).
 */
export function clampThreadPaneWidth(width: number, containerWidth: number): number {
  if (!Number.isFinite(width)) return THREAD_PANE_DEFAULT_WIDTH
  const max =
    Number.isFinite(containerWidth) && containerWidth > 0
      ? Math.max(THREAD_PANE_MIN_WIDTH, containerWidth - THREAD_STREAM_MIN_WIDTH)
      : Number.POSITIVE_INFINITY
  return Math.round(Math.min(Math.max(width, THREAD_PANE_MIN_WIDTH), max))
}

/**
 * Turn a stored localStorage value into a usable width. Garbage, absent, or
 * out-of-range values fall back to the default rather than throwing — a stale
 * or hand-edited key must never break the chat.
 */
export function readStoredThreadPaneWidth(raw: string | null | undefined): number {
  if (raw == null || raw === '') return THREAD_PANE_DEFAULT_WIDTH
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return THREAD_PANE_DEFAULT_WIDTH
  return clampThreadPaneWidth(n, Number.POSITIVE_INFINITY)
}
