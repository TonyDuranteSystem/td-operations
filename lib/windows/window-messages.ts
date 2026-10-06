/**
 * The conversation between a floating window's page (the frame) and the main page (dev job
 * f3f3e237, step 5). Plain data both sides agree on, plus the checks that stop either side from
 * acting on a message it should not trust. Pure so it is unit-tested (R086).
 *
 * Every message carries `t: 'td-win'`. The receiver ALSO checks the sender (same site, and the
 * exact frame / parent it expects) — this module only validates the shape.
 */

import { isInternalNavHref } from '@/lib/nav/nav-link'

export const WIN_MSG = 'td-win'

/** Frame → main page. */
export type FrameMessage =
  /** The page inside the window is now at `url` (path + query) and is titled `title`. */
  | { t: typeof WIN_MSG; k: 'loc'; url: string; title: string; replace?: boolean }
  /** The person clicked or focused something inside the window: bring it to the front. */
  | { t: typeof WIN_MSG; k: 'focus' }
  /** The page asked to go back (a page's own back arrow calls history.back): the window's own Back handles it. */
  | { t: typeof WIN_MSG; k: 'back' }
  /** A shortcut the main page owns (Cmd/Ctrl+K opens the search palette). */
  | { t: typeof WIN_MSG; k: 'key'; key: 'k' }
  /** Answer to "is there typing here that would be lost?" */
  | { t: typeof WIN_MSG; k: 'dirty-answer'; req: string; dirty: boolean }

/** Main page → frame. */
export type ParentMessage =
  /** Show this page (client-side, no reload). Used by the window's back / forward. */
  | { t: typeof WIN_MSG; k: 'go'; url: string }
  /** Ask whether the page holds typing that has not been sent or saved. */
  | { t: typeof WIN_MSG; k: 'ask-dirty'; req: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a message coming from a frame. Anything unexpected is rejected (returns null). */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isObject(data) || data.t !== WIN_MSG) return null
  switch (data.k) {
    case 'loc':
      if (typeof data.url !== 'string' || typeof data.title !== 'string') return null
      // The frame's path is read from its own address bar; it is NOT trusted to be a window page —
      // the manager runs it through the windowable-address rules itself. Only reject non-paths.
      if (!isInternalNavHref(data.url)) return null
      return {
        t: WIN_MSG, k: 'loc', url: data.url.slice(0, 2000), title: data.title.slice(0, 200),
        // true when the page REPLACED its address (a redirect / tidy-up), not a new page: no new Back step.
        replace: data.replace === true,
      }
    case 'focus':
      return { t: WIN_MSG, k: 'focus' }
    case 'back':
      return { t: WIN_MSG, k: 'back' }
    case 'key':
      return data.key === 'k' ? { t: WIN_MSG, k: 'key', key: 'k' } : null
    case 'dirty-answer':
      if (typeof data.req !== 'string' || typeof data.dirty !== 'boolean') return null
      return { t: WIN_MSG, k: 'dirty-answer', req: data.req.slice(0, 64), dirty: data.dirty }
    default:
      return null
  }
}

/** Validate a message coming from the main page. */
export function parseParentMessage(data: unknown): ParentMessage | null {
  if (!isObject(data) || data.t !== WIN_MSG) return null
  switch (data.k) {
    case 'go':
      return typeof data.url === 'string' && isInternalNavHref(data.url)
        ? { t: WIN_MSG, k: 'go', url: data.url.slice(0, 2000) }
        : null
    case 'ask-dirty':
      return typeof data.req === 'string' ? { t: WIN_MSG, k: 'ask-dirty', req: data.req.slice(0, 64) } : null
    default:
      return null
  }
}

/**
 * Typing that would be lost. The frame remembers which fields the person typed into; this decides,
 * from those fields' CURRENT content, whether anything is still sitting unsent. A box that was typed
 * in and then emptied (a message that was sent) is not "unsaved".
 */
export function hasUnsentTyping(fields: Array<{ connected: boolean; text: string }>): boolean {
  return fields.some(f => f.connected && f.text.trim().length > 0)
}
