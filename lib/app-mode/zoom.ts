/**
 * Pinch-zoom inside the TD Social phone app (dev job 2072bc3e, round two, 6 Nov 2026).
 *
 * The CRM, TD Talk and the client portal tell the phone "no zooming" in their page settings (maximum-scale=1, user-scalable=no). On a computer-size
 * page that is harmless; on a phone it means a wide email shrunk to fit the screen can never be enlarged. In the app the lock is lifted by
 * rewriting ONLY the zoom words of the page's own setting (it can then be enlarged up to 5x but never shrunk below the screen; everything else, such as viewport-fit=cover, stays exactly as the page wrote it).
 * Pure, so it is tested without a phone.
 */

/** the largest zoom a pinch can reach */
export const APP_MAX_ZOOM = 5
/** the smallest: the page as it fits the screen. Without this the iPhone lets a pinch shrink the page to a quarter, leaving blank margins around it. */
export const APP_MIN_ZOOM = 1

const ZOOM_WORDS = new Set(['maximum-scale', 'minimum-scale', 'user-scalable'])

/** The same viewport setting with pinch-zoom allowed: the page's zoom words are replaced, every other word is kept in its place. */
export function allowPinchZoom(content: string | null | undefined): string {
  const kept = (content ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !ZOOM_WORDS.has(part.split('=')[0].trim().toLowerCase()))
  if (!kept.some(part => part.toLowerCase().startsWith('width='))) kept.unshift('width=device-width')
  return [...kept, `minimum-scale=${APP_MIN_ZOOM}`, `maximum-scale=${APP_MAX_ZOOM}`, 'user-scalable=yes'].join(', ')
}

/** Applies it to the page's viewport tag. Returns true when it had to change something (so a caller can tell a real change from a no-op). */
export function applyPinchZoom(doc: Document): boolean {
  let tag = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!tag) {
    tag = doc.createElement('meta')
    tag.name = 'viewport'
    doc.head.appendChild(tag)
  }
  const next = allowPinchZoom(tag.getAttribute('content'))
  if (tag.getAttribute('content') === next) return false
  tag.setAttribute('content', next)
  return true
}
