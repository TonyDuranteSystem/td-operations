/**
 * What the window manager reports about things a PERSON did to a window (dev job f3f3e237 — the guided
 * tour waits for these). Sent from the exact places the manager acts on a person's click or drag, never
 * derived from state differences: a screen resize, a reload that brings windows back, or a sign-out also
 * change state, and none of those must ever count as "the person moved the window".
 * Pure + DOM-event plumbing only, so it is unit-tested without a browser (R086).
 */

export const WINDOW_EVENT = 'td-window-event'

export type WindowEventDetail =
  /** A page was opened in a window. `reused` = it was already open and was only brought forward. */
  | { type: 'opened'; id: string; url: string; reused: boolean }
  | { type: 'moved'; id: string }
  | { type: 'resized'; id: string }
  | { type: 'minimized'; id: string }
  | { type: 'restored'; id: string }
  /** `reason` tells a plain close from a pop-out, a "move to the main page", or the system removing a dead window — all remove it. */
  | { type: 'closed'; id: string; reason: 'closed' | 'popout' | 'docked' | 'removed' }

export function emitWindowEvent(detail: WindowEventDetail): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent<WindowEventDetail>(WINDOW_EVENT, { detail }))
}

/** Subscribe; returns the unsubscribe function. */
export function onWindowEvent(handler: (d: WindowEventDetail) => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const listener = (e: Event) => {
    const d = (e as CustomEvent<WindowEventDetail>).detail
    if (d && typeof d.type === 'string') handler(d)
  }
  document.addEventListener(WINDOW_EVENT, listener)
  return () => document.removeEventListener(WINDOW_EVENT, listener)
}

/** How far a drag must travel before it counts as moving / resizing (a bare click on the bar is neither). */
export const MIN_DRAG_PX = 20

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** What a finished drag amounted to, or null for "nothing worth reporting". */
export function classifyDrag(start: Box, end: Box, mode: 'move' | 'resize'): 'moved' | 'resized' | null {
  if (mode === 'move') {
    return Math.hypot(end.x - start.x, end.y - start.y) >= MIN_DRAG_PX ? 'moved' : null
  }
  return Math.abs(end.w - start.w) + Math.abs(end.h - start.h) >= MIN_DRAG_PX ? 'resized' : null
}
