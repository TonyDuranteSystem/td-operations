/**
 * Which clicks / keys mean "open this as a floating window" (dev job f3f3e237, step 6).
 *
 * The browser already owns Cmd/Ctrl-click (new tab) and Shift-click (new browser window), and the
 * CRM leaves those alone, so a left-menu click means "window" only with Option/Alt held and NOTHING
 * else. In the search palette Enter is "open here", so Cmd/Ctrl+Enter is free to mean "as a window".
 * Pure so the rules are unit-tested (R086).
 */

export interface ClickLike {
  button?: number
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/** Option/Alt + plain left click — and no other modifier, so it never fights the browser's own. */
export function isWindowOpenClick(e: ClickLike): boolean {
  return (e.button ?? 0) === 0 && e.altKey === true && !e.metaKey && !e.ctrlKey && !e.shiftKey
}

export interface KeyLike {
  key: string
  altKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/** Cmd+Enter (Mac) or Ctrl+Enter (elsewhere) in the search palette. */
export function isWindowOpenKey(e: KeyLike): boolean {
  return e.key === 'Enter' && (e.metaKey === true || e.ctrlKey === true) && !e.altKey && !e.shiftKey
}

/**
 * A click on a link that should open the page as a floating window when windows are available (the Calendar's "Open workspace").
 * A plain left click, or Option/Alt + click, means "window". Cmd/Ctrl-click (new tab) and Shift-click (new browser window) stay the
 * browser's own, per Antonio's "leave native mouse behaviour alone" (see isWindowOpenClick above).
 */
export function isWindowLinkClick(e: ClickLike): boolean {
  return (e.button ?? 0) === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey
}
