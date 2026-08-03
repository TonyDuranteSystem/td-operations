/**
 * E-Sign coordinate transforms — the single most error-prone piece of the system.
 *
 * Two coordinate systems collide:
 *  - Editor / browser: TOP-LEFT origin, CSS pixels, y grows DOWN.
 *  - pdf-lib / PDF:    BOTTOM-LEFT origin, PDF points, y grows UP.
 *
 * Canonical stored form: NORMALIZED fractions (0..1) of the page box, TOP-LEFT
 * origin — resolution/zoom independent (so a field placed at any editor zoom or
 * device pixel ratio lands in the same spot). The editor captures into this
 * form; the server flatten converts out of it into pdf-lib points with a Y-flip.
 *
 * Pure + unit-tested. No DOM, no pdf-lib imports — safe on client and server.
 */

/** Normalized field rect: fractions of the page, top-left origin. Matches the esign_fields columns. */
export interface NormalizedRect {
  /** Left edge, fraction of page width, 0..1. */
  pos_x: number
  /** Top edge, fraction of page height, 0..1 (top-left origin). */
  pos_y: number
  /** Width, fraction of page width, 0..1. */
  width: number
  /** Height, fraction of page height, 0..1. */
  height: number
}

/** A box in pdf-lib space: PDF points, bottom-left origin. `y` is the BOTTOM edge (drawImage/drawText anchor). */
export interface PdfRect {
  x: number
  y: number
  width: number
  height: number
}

/** A box in DOM space: CSS pixels, top-left origin. */
export interface DomBox {
  left: number
  top: number
  width: number
  height: number
}

const EPS = 1e-9

/** Clamp a number into [0, 1]; NaN → 0. */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** Clamp a normalized rect so it stays fully on the page (pos+size never exceeds 1). */
export function clampNormalizedRect(r: NormalizedRect): NormalizedRect {
  const width = clamp01(r.width)
  const height = clamp01(r.height)
  const pos_x = clamp01(Math.min(r.pos_x, 1 - width))
  const pos_y = clamp01(Math.min(r.pos_y, 1 - height))
  return { pos_x, pos_y, width, height }
}

/** True when a rect is finite, has positive size, and fits on the page. */
export function isValidNormalizedRect(r: NormalizedRect): boolean {
  const vals = [r.pos_x, r.pos_y, r.width, r.height]
  if (vals.some(v => typeof v !== 'number' || !Number.isFinite(v))) return false
  if (r.width <= 0 || r.height <= 0) return false
  if (r.pos_x < -EPS || r.pos_y < -EPS) return false
  if (r.pos_x + r.width > 1 + EPS) return false
  if (r.pos_y + r.height > 1 + EPS) return false
  return true
}

/** Editor capture: a DOM pixel box (top-left) over the page layer → normalized fractions. */
export function domBoxToNormalized(box: DomBox, layerWidthPx: number, layerHeightPx: number): NormalizedRect {
  if (layerWidthPx <= 0 || layerHeightPx <= 0) {
    throw new Error('layer dimensions must be positive')
  }
  return clampNormalizedRect({
    pos_x: box.left / layerWidthPx,
    pos_y: box.top / layerHeightPx,
    width: box.width / layerWidthPx,
    height: box.height / layerHeightPx,
  })
}

/** Editor render: normalized fractions → DOM pixel box at the current layer size. Inverse of domBoxToNormalized. */
export function normalizedToDomBox(r: NormalizedRect, layerWidthPx: number, layerHeightPx: number): DomBox {
  return {
    left: r.pos_x * layerWidthPx,
    top: r.pos_y * layerHeightPx,
    width: r.width * layerWidthPx,
    height: r.height * layerHeightPx,
  }
}

/**
 * True when a rect is entirely outside the viewport — i.e. a scroll that was
 * supposed to bring it into view did nothing.
 *
 * WHY THIS EXISTS: `scrollIntoView({ behavior: "smooth" })` is a silent NO-OP in
 * some engines (proven in QA on 2026-08-03: the same call with `behavior` omitted
 * scrolled correctly, with it the page did not move at all). A "take me to the
 * field" button that quietly does nothing is worse than no button, because the
 * client concludes the document itself is broken — the exact complaint this whole
 * change exists to answer. The caller uses this to detect the no-op and re-issue
 * the scroll instantly.
 */
export function isRectOutOfView(rect: { top: number; bottom: number }, viewportHeightPx: number): boolean {
  if (!Number.isFinite(rect?.top) || !Number.isFinite(rect?.bottom)) return false
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return false
  return rect.bottom < 0 || rect.top > viewportHeightPx
}

/**
 * Grow a rendered field box to a minimum on-screen size, around its own centre.
 *
 * WHY: staff draw signature boxes onto the PDF at whatever height the form's
 * signature line happens to be — real tax returns give it ~1.6% of the page,
 * which renders as a ~10px strip a client cannot see or hit (Adam Marra /
 * Azor Consulting, 2026-08-03: 8-page return, signature at pos_y 0.869,
 * height 0.0164; he never found it and the submit button stayed disabled).
 *
 * This is a DISPLAY-ONLY transform for the signer screen. The stored normalized
 * rect is untouched, so `normalizedToPdfRect` still stamps the signature exactly
 * on the form's line — and every envelope ALREADY out with a client is repaired
 * on next render, with no data migration and no reissue.
 *
 * Grows symmetrically then slides back inside the page, so the box never leaves
 * the layer. Never shrinks. A minimum larger than the page collapses to the page.
 */
export function expandDomBoxToMinimum(
  box: DomBox,
  minWidthPx: number,
  minHeightPx: number,
  layerWidthPx: number,
  layerHeightPx: number,
): DomBox {
  const safe = (n: number) => (Number.isFinite(n) ? n : 0)
  const layerW = Math.max(safe(layerWidthPx), 0)
  const layerH = Math.max(safe(layerHeightPx), 0)

  const width = Math.min(Math.max(safe(box.width), safe(minWidthPx)), layerW || safe(box.width))
  const height = Math.min(Math.max(safe(box.height), safe(minHeightPx)), layerH || safe(box.height))

  // Nothing to grow → hand the box back untouched. Without this, the clamp below
  // would SLIDE a box that hangs off the page edge (a rect stored with
  // pos_x + width > 1) sideways on screen, away from where the flatten will
  // stamp it — showing the signer a box in one place and signing in another.
  if (width === safe(box.width) && height === safe(box.height)) return { ...box }

  const centreX = safe(box.left) + safe(box.width) / 2
  const centreY = safe(box.top) + safe(box.height) / 2

  const left = Math.min(Math.max(centreX - width / 2, 0), Math.max(layerW - width, 0))
  const top = Math.min(Math.max(centreY - height / 2, 0), Math.max(layerH - height, 0))

  return { left, top, width, height }
}

/**
 * Flatten: normalized fractions (top-left) → pdf-lib points (bottom-left).
 *
 * The returned `y` is the BOTTOM edge of the box — what pdf-lib's drawImage and
 * drawText use as the anchor. The Y-flip is `H - top - height`.
 *
 * Only unrotated pages (page /Rotate = 0) are supported. A rotated page would
 * place the field in the wrong spot, so we refuse rather than silently misplace
 * the signature (rotated PDFs are a later phase per the plan).
 */
export function normalizedToPdfRect(
  r: NormalizedRect,
  pageWidthPt: number,
  pageHeightPt: number,
  pageRotationDegrees = 0,
): PdfRect {
  if (pageWidthPt <= 0 || pageHeightPt <= 0) {
    throw new Error('page dimensions must be positive')
  }
  const rot = ((Math.round(pageRotationDegrees) % 360) + 360) % 360
  if (rot !== 0) {
    throw new Error(`rotated pages not supported yet (page /Rotate = ${rot}); refusing to misplace the field`)
  }
  const width = r.width * pageWidthPt
  const height = r.height * pageHeightPt
  const x = r.pos_x * pageWidthPt
  const y = pageHeightPt - r.pos_y * pageHeightPt - height
  return { x, y, width, height }
}
