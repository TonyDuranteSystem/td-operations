/**
 * Helpers for the left-menu ⋯ menu (dev job f3f3e237, step 1).
 *
 * Pure on purpose: the menu component stays thin, and the two decisions that
 * can go wrong — "is this an address we are willing to open/copy" and "what
 * absolute link do we put on the clipboard" — are unit-tested without a DOM.
 */

/**
 * True only for a normal CRM page path: a single leading slash, no scheme, no
 * protocol-relative `//host`, no backslash tricks, no control characters.
 *
 * The left menu's own list is trusted code, but the same check is the gate the
 * future window system will reuse for restored/opened addresses (the bug
 * hunter's "never open `//evil.com` or `javascript:`" condition), so it is
 * strict from day one.
 */
export function isInternalNavHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length === 0) return false
  if (!href.startsWith('/')) return false
  if (href.startsWith('//')) return false
  if (href.includes('\\')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return false
  return true
}

/**
 * Absolute link for "Copy link": the page's origin plus its path. Returns null
 * for anything that is not an internal path or when there is no usable origin,
 * so the caller can show an honest error instead of copying garbage.
 */
export function absoluteNavUrl(origin: string | null | undefined, href: unknown): string | null {
  if (!isInternalNavHref(href)) return null
  if (typeof origin !== 'string') return null
  const base = origin.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/\s]+$/i.test(base)) return null
  return `${base}${href}`
}
