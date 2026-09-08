/**
 * Floating chat window — how big it is, per device.
 *
 * Sibling of chat-window-position.ts (position and size are stored, clamped,
 * and persisted separately — same reasoning as that file's own header: a
 * distinct localStorage key so the notes-layer prune can never touch it, and
 * clamping measured against real numbers rather than a guessed constant).
 *
 * Pure so the clamp is unit-testable without a DOM (R086).
 *
 * Stored in PIXELS, not viewport fractions (unlike position): a chat window's
 * minimum usable size is a property of its CONTENT (a message bubble, the
 * composer, the header buttons all need a real pixel floor to stay legible),
 * not something that should shrink just because the screen is smaller. The
 * cross-device risk that fractions solve for position — a spot picked on a
 * 27" iMac must still land on-screen on a laptop — is solved for size the
 * same way position ITSELF still solves it: `clampChatWindowSize` caps
 * against the CURRENT viewport at read/resize time, so a size stored on a
 * bigger screen simply shrinks to fit a smaller one rather than staying
 * off-screen or unreadable.
 */

/** localStorage key holding the window's size. Never the position or notes key. */
export const CHAT_WINDOW_SIZE_KEY = 'td-floating-chat-size-v1'

export interface PxSize {
  /** Width in px. */
  w: number
  /** Height in px. */
  h: number
}

/** Where the window opens before the user has ever resized it. */
export const CHAT_WINDOW_DEFAULT_SIZE: PxSize = { w: 360, h: 520 }

/** Below this, the header buttons and a message bubble stop being usable. */
export const CHAT_WINDOW_MIN_SIZE: PxSize = { w: 320, h: 360 }

/** Absolute ceiling — further capped to the viewport at clamp time, so this
 *  is "as big as it can ever get," not "as big as it will actually be." */
export const CHAT_WINDOW_MAX_SIZE: PxSize = { w: 640, h: 800 }

/**
 * Clamp a size so it never drops below the usable floor and never exceeds
 * either the absolute ceiling or the current viewport (leaving a margin so
 * the window's own border/shadow never touches the screen edge).
 *
 * A non-finite or absent viewport measurement (SSR, first paint) skips the
 * viewport half of the clamp — the caller re-clamps once it has real numbers,
 * same convention as clampChatWindowPos.
 */
export function clampChatWindowSize(size: PxSize, viewport: { vw?: number; vh?: number } = {}): PxSize {
  const maxW = viewportCeiling(viewport.vw, CHAT_WINDOW_MAX_SIZE.w, 0.92)
  // A taller cap than width's — Antonio's own complaint was that the window
  // reads as cramped, and height has more room to give on a typical desktop
  // display before it crowds the header/composer chrome above and below it.
  const maxH = viewportCeiling(viewport.vh, CHAT_WINDOW_MAX_SIZE.h, 0.85)
  return {
    w: clampAxis(size?.w, CHAT_WINDOW_MIN_SIZE.w, maxW),
    h: clampAxis(size?.h, CHAT_WINDOW_MIN_SIZE.h, maxH),
  }
}

function viewportCeiling(viewportPx: unknown, absoluteMax: number, fraction: number): number {
  if (typeof viewportPx !== 'number' || !Number.isFinite(viewportPx) || viewportPx <= 0) return absoluteMax
  return Math.min(absoluteMax, viewportPx * fraction)
}

function clampAxis(value: unknown, min: number, max: number): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : min
  // A viewport small enough to push max below min (e.g. a genuinely tiny
  // window) still returns something drawable rather than an inverted range.
  const hi = Math.max(max, min)
  return Math.min(Math.max(v, min), hi)
}

/**
 * Turn a stored localStorage value into a usable size. Garbage, absent, or
 * partial values fall back to the default rather than throwing — a stale or
 * hand-edited key must never break the chat. Not clamped here: the caller
 * clamps once it knows the real viewport.
 */
export function readStoredChatWindowSize(raw: string | null | undefined): PxSize {
  if (raw == null || raw === '') return { ...CHAT_WINDOW_DEFAULT_SIZE }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...CHAT_WINDOW_DEFAULT_SIZE }
    const { w, h } = parsed as { w?: unknown; h?: unknown }
    if (typeof w !== 'number' || !Number.isFinite(w)) return { ...CHAT_WINDOW_DEFAULT_SIZE }
    if (typeof h !== 'number' || !Number.isFinite(h)) return { ...CHAT_WINDOW_DEFAULT_SIZE }
    return { w, h }
  } catch {
    return { ...CHAT_WINDOW_DEFAULT_SIZE }
  }
}

/** Serialize a size for storage. */
export function serializeChatWindowSize(size: PxSize): string {
  return JSON.stringify({ w: size.w, h: size.h })
}
