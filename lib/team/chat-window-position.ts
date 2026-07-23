/**
 * Floating chat window — where it sits, per device.
 *
 * Pure so the clamping rules are unit-testable without a DOM (R086), and
 * deliberately SEPARATE from lib/notes/note-position.ts. Two reasons, both of
 * which bit during review:
 *
 *  1. THE KEY. The notes layer owns one storage map and prunes it on every
 *     refetch (~60s), deleting every entry whose key is not a live NOTE id. A
 *     chat position parked in that map is wiped within a minute — the user drags
 *     the window, reloads, and it has silently jumped home. The chat window gets
 *     its own key so the notes prune can never see it.
 *
 *  2. THE CLAMP. note-position caps the top-left at 92% of the viewport, which
 *     is right for a 240px card and wrong for a ~360px window: at 92% on a
 *     1440px screen the window's left edge lands at 1325px, so most of it —
 *     including the composer and the close button — is off-screen, and that
 *     position is then persisted with no way back. Here the clamp is measured
 *     against the window's ACTUAL size, so the whole thing always stays on
 *     screen whatever it is dragged onto.
 *
 * Positions are stored as viewport FRACTIONS, never pixels: a spot chosen on a
 * 27" iMac must still be on-screen when the same account opens the PWA at 380px.
 */

/** localStorage key holding the window's position. Never the notes key. */
export const CHAT_WINDOW_POS_KEY = 'td-floating-chat-pos-v1'

/** Where the window opens before the user has ever dragged it. */
export const CHAT_WINDOW_DEFAULT_POS: FracPos = { x: 0.62, y: 0.12 }

export interface FracPos {
  /** Left edge as a fraction of viewport width (0..1). */
  x: number
  /** Top edge as a fraction of viewport height (0..1). */
  y: number
}

export interface ViewportBox {
  /** Viewport width in px. */
  vw: number
  /** Viewport height in px. */
  vh: number
  /** The window's measured width in px. */
  w: number
  /** The window's measured height in px. */
  h: number
}

/**
 * Clamp a fractional position so the window stays fully on screen.
 *
 * The maximum is derived from the MEASURED element, not a constant: the last
 * legal left edge is (viewport - element), expressed as a fraction. When the
 * element is larger than the viewport in an axis (a tall window on a short
 * phone) the max goes negative — we pin to 0 there, showing the top-left corner,
 * because the alternative is scrolling the close button off the screen.
 *
 * A non-finite or absent measurement means "not laid out yet" (SSR, first
 * paint). We clamp to 0..1 in that case rather than guessing an element size —
 * the caller re-clamps once the ref has a box.
 */
export function clampChatWindowPos(pos: FracPos, box: Partial<ViewportBox> = {}): FracPos {
  return { x: clampAxis(pos?.x, box.vw, box.w), y: clampAxis(pos?.y, box.vh, box.h) }
}

function clampAxis(frac: unknown, viewport?: number, element?: number): number {
  const f = typeof frac === 'number' && Number.isFinite(frac) ? frac : 0
  let max = 1
  if (Number.isFinite(viewport) && (viewport as number) > 0 && Number.isFinite(element) && (element as number) > 0) {
    max = ((viewport as number) - (element as number)) / (viewport as number)
  }
  if (!Number.isFinite(max) || max < 0) max = 0 // element bigger than viewport → pin to the corner
  return Math.min(Math.max(f, 0), Math.min(max, 1))
}

/**
 * Turn a stored localStorage value into a usable position. Garbage, absent, or
 * partial values fall back to the default rather than throwing — a stale or
 * hand-edited key must never break the chat. Not clamped here: the caller
 * clamps once it has measured the element.
 */
export function readStoredChatWindowPos(raw: string | null | undefined): FracPos {
  if (raw == null || raw === '') return { ...CHAT_WINDOW_DEFAULT_POS }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...CHAT_WINDOW_DEFAULT_POS }
    const { x, y } = parsed as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || !Number.isFinite(x)) return { ...CHAT_WINDOW_DEFAULT_POS }
    if (typeof y !== 'number' || !Number.isFinite(y)) return { ...CHAT_WINDOW_DEFAULT_POS }
    return { x, y }
  } catch {
    return { ...CHAT_WINDOW_DEFAULT_POS }
  }
}

/** Serialize a position for storage. */
export function serializeChatWindowPos(pos: FracPos): string {
  return JSON.stringify({ x: pos.x, y: pos.y })
}
