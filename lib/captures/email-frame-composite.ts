/**
 * Capture/Share — compositing an Inbox email's sandboxed iframe into a page
 * capture. html2canvas's own cross-frame clone-and-paint path silently
 * produces a near-blank render for SOME (not all) emails inside
 * EmailHtmlFrame's sandboxed srcDoc iframe — confirmed live, 2026-09-23: a
 * plain-text control email rendered correctly through that path, a richer
 * Gmail "Address not found" bounce notice did not, using the identical
 * component both times. Root cause not pinned to one exact CSS/markup
 * trigger, but isolated to html2canvas's OWN cross-frame clone mechanism
 * specifically — calling html2canvas directly against the iframe's OWN
 * document (`iframe.contentDocument.body`) instead rendered correctly every
 * time tested (confirmed both content and a control image).
 *
 * Two-round adversarial review (Antonio's explicit request, 2026-09-23):
 * - Whether html2canvas's render process could reintroduce script execution
 *   the iframe's sandbox blocks was tested live with an actual payload
 *   (inline `onerror` + a raw `<script>` tag) — neither fired, before or
 *   after running html2canvas against that iframe's own document. Confirmed
 *   independently by reading html2canvas's nested-iframe handling: it reads
 *   the iframe's live DOM tree and paints it directly — it never
 *   re-serializes the HTML into a fresh, unsandboxed context. Closed.
 * - A UI "lock" during rendering (considered, to close a race where the
 *   captured email could change mid-capture — e.g. staff switches to a
 *   different client's conversation between the two renders) was REJECTED:
 *   new coupling between this generic tool and Inbox-specific internals,
 *   with no clean release guarantee on every exit path — this exact bug
 *   class (state not reset when the tool closes mid-flight) is this
 *   feature's single most repeated real defect (see captures.md Gotchas).
 *   Replaced with cheaper, sufficient protection: re-verify nothing changed
 *   immediately before compositing, and quietly drop — never guess at — any
 *   iframe that did. `checkEmailFrameStillValid` below is that check.
 *
 * Scope: only `captureRegion` uses this. `captureWholePage` has its own,
 * separate, already-tracked, not-yet-root-caused bug (silently fails on the
 * Dashboard — captures.md's "Gotchas" section) with its own unresolved
 * scroll/coordinate questions; building this fix's compositing math on top
 * of that unrelated, already-broken coordinate handling would be building on
 * sand. Antonio's actual report and reproduction were both a region capture.
 */

export const EMAIL_FRAME_ATTR = 'data-capture-email-frame'
export const EMAIL_FRAME_IDENTITY_ATTR = 'data-mid'

export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

/** Snapshot of one email iframe's identity + geometry, taken once when a capture begins. */
export interface EmailFrameSnapshot {
  identity: string
  /** Viewport-relative bounding rect at snapshot time. EmailHtmlFrame sizes
   *  its iframe element to its own measured content height, so this rect's
   *  height already reflects content height — no separate field needed. */
  rect: ViewportRect
}

/** What the same iframe looks like right now — read again immediately before compositing. */
export interface EmailFrameCurrentState {
  attached: boolean
  identity: string | null
  rect: ViewportRect | null
}

export type EmailFrameValidity =
  | { valid: true }
  | { valid: false; reason: 'removed' | 'identity-changed' | 'size-or-position-changed' }

/**
 * Does this snapshot still match reality? Never trust stale geometry or a
 * stale identity — either invalidates the crop math computed against it.
 */
export function checkEmailFrameStillValid(snapshot: EmailFrameSnapshot, current: EmailFrameCurrentState): EmailFrameValidity {
  if (!current.attached || current.identity === null || current.rect === null) {
    return { valid: false, reason: 'removed' }
  }
  if (current.identity !== snapshot.identity) {
    return { valid: false, reason: 'identity-changed' }
  }
  const r = current.rect
  if (r.x !== snapshot.rect.x || r.y !== snapshot.rect.y || r.width !== snapshot.rect.width || r.height !== snapshot.rect.height) {
    return { valid: false, reason: 'size-or-position-changed' }
  }
  return { valid: true }
}

/** Do these two viewport rects actually overlap at all? */
export function rectsIntersect(a: ViewportRect, b: ViewportRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** The overlapping portion of two viewport rects, or null if they don't actually overlap. */
export function intersectRects(a: ViewportRect, b: ViewportRect): ViewportRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

export interface CompositeDraw {
  /** Crop rect within the iframe's OWN separately-rendered canvas, in that canvas's own pixels. */
  src: ViewportRect
  /** Destination rect within the outer page capture's canvas, in that canvas's own pixels. */
  dest: ViewportRect
}

/**
 * Where to crop the iframe's own canvas from, and where to draw it onto the
 * outer region capture's canvas — in pixels, matching each canvas's own
 * scale. `captureRegion`'s outer canvas is scroll-compensated to the
 * SELECTED REGION's own top-left (render.ts passes `scrollX: -window.scrollX,
 * scrollY: -window.scrollY`), so its pixel (0,0) is the region's own origin,
 * not the document's — subtract the region's origin, never the page's
 * scroll offset. Returns null if the iframe and the selected region don't
 * actually overlap (shouldn't happen for an already-filtered candidate, but
 * never assumed).
 */
export function computeCompositeDraw(iframeRect: ViewportRect, regionRect: ViewportRect, scale: number): CompositeDraw | null {
  const overlap = intersectRects(iframeRect, regionRect)
  if (!overlap) return null
  return {
    src: {
      x: (overlap.x - iframeRect.x) * scale,
      y: (overlap.y - iframeRect.y) * scale,
      width: overlap.width * scale,
      height: overlap.height * scale,
    },
    dest: {
      x: (overlap.x - regionRect.x) * scale,
      y: (overlap.y - regionRect.y) * scale,
      width: overlap.width * scale,
      height: overlap.height * scale,
    },
  }
}

/** Finds every email-content iframe on the page whose current bounds overlap the selected region, with a snapshot of each. Browser-only. */
export function findOverlappingEmailFrameSnapshots(regionRect: ViewportRect): Array<{ iframe: HTMLIFrameElement; snapshot: EmailFrameSnapshot }> {
  const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>(`[${EMAIL_FRAME_ATTR}]`))
  const found: Array<{ iframe: HTMLIFrameElement; snapshot: EmailFrameSnapshot }> = []
  for (const iframe of iframes) {
    const identity = iframe.closest(`[${EMAIL_FRAME_IDENTITY_ATTR}]`)?.getAttribute(EMAIL_FRAME_IDENTITY_ATTR)
    if (!identity) continue
    const r = iframe.getBoundingClientRect()
    const rect: ViewportRect = { x: r.x, y: r.y, width: r.width, height: r.height }
    if (!rectsIntersect(rect, regionRect)) continue
    found.push({ iframe, snapshot: { identity, rect } })
  }
  return found
}

/** Reads an email iframe's current identity + geometry, for comparing against an earlier snapshot. Browser-only. */
export function readEmailFrameCurrentState(iframe: HTMLIFrameElement): EmailFrameCurrentState {
  if (!iframe.isConnected) {
    return { attached: false, identity: null, rect: null }
  }
  const identity = iframe.closest(`[${EMAIL_FRAME_IDENTITY_ATTR}]`)?.getAttribute(EMAIL_FRAME_IDENTITY_ATTR) ?? null
  const r = iframe.getBoundingClientRect()
  return { attached: true, identity, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
}
