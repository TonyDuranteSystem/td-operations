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
