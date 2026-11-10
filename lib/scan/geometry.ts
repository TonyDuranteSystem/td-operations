/**
 * Scan document: the shapes. Pure maths, no browser, so it can be tested.
 * A page is a Quad: its four corners in the order top-left, top-right, bottom-right, bottom-left.
 */

export interface Point { x: number; y: number }
export type Quad = [Point, Point, Point, Point]
/** RGBA pixels, like a canvas ImageData. */
export interface Raster { data: Uint8ClampedArray; width: number; height: number }

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Shoelace area (always positive). */
export function polygonArea(pts: ReadonlyArray<Point>): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]; const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export const quadArea = (q: Quad): number => polygonArea(q)

/** Puts any four points into top-left, top-right, bottom-right, bottom-left order. */
export function orderQuad(pts: ReadonlyArray<Point>): Quad {
  if (pts.length !== 4) throw new Error('orderQuad needs exactly four points')
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  // clockwise on screen (y points down) = ascending angle
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  // start from the corner nearest the top-left
  let start = 0
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i
  return [0, 1, 2, 3].map(k => sorted[(start + k) % 4]) as Quad
}

export function quadSides(q: Quad): { top: number; right: number; bottom: number; left: number } {
  return { top: dist(q[0], q[1]), right: dist(q[1], q[2]), bottom: dist(q[2], q[3]), left: dist(q[3], q[0]) }
}

/** Interior angle at corner i, in degrees. */
export function cornerAngle(q: Quad, i: number): number {
  const p = q[i]; const a = q[(i + 3) % 4]; const b = q[(i + 1) % 4]
  const v1 = { x: a.x - p.x, y: a.y - p.y }; const v2 = { x: b.x - p.x, y: b.y - p.y }
  const d = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1)
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

/** True when the four corners make a proper convex shape (no bow-tie, no collapsed side). */
export function isConvexQuad(q: Quad): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]; const b = q[(i + 1) % 4]; const c = q[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) return false
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** A starting rectangle a little inside the picture, for when no page was found. */
export function defaultQuad(width: number, height: number, inset = 0.08): Quad {
  const dx = width * inset; const dy = height * inset
  return [{ x: dx, y: dy }, { x: width - dx, y: dy }, { x: width - dx, y: height - dy }, { x: dx, y: height - dy }]
}

/** Keeps every corner inside the picture. */
export function clampQuad(q: Quad, width: number, height: number): Quad {
  return q.map(p => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) })) as Quad
}

export function scaleQuad(q: Quad, fx: number, fy: number = fx): Quad {
  return q.map(p => ({ x: p.x * fx, y: p.y * fy })) as Quad
}

/**
 * The size of the straightened page: the longer of each pair of opposite sides (so no detail is thrown away),
 * then shrunk so the long side is at most `maxLong`. Never below 2 pixels.
 */
export function outputSize(q: Quad, maxLong: number): { width: number; height: number } {
  const s = quadSides(q)
  let w = Math.max(s.top, s.bottom)
  let h = Math.max(s.left, s.right)
  const long = Math.max(w, h)
  if (long > maxLong) { const k = maxLong / long; w *= k; h *= k }
  return { width: Math.max(2, Math.round(w)), height: Math.max(2, Math.round(h)) }
}

/**
 * The 8 numbers (a perspective map, 3x3 with the last one fixed at 1) that send the corners of a width x height
 * rectangle onto the four corners of `q`. Null when the corners are degenerate (all on one line).
 */
export function homographyRectToQuad(q: Quad, width: number, height: number): number[] | null {
  const src: Point[] = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = src[i]; const { x, y } = q[i]
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x)
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y)
  }
  return solveLinear(A, b)
}

/** Gaussian elimination with partial pivoting. Null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    if (Math.abs(M[pivot][col]) < 1e-10) return null
    ;[M[col], M[pivot]] = [M[pivot], M[col]]
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c]
    x[r] = s / M[r][r]
  }
  return x
}

/** Straightens the page: every pixel of the new width x height picture is read (smoothly) from the matching spot inside `q`. */
export function warpPerspective(src: Raster, q: Quad, outW: number, outH: number): Raster {
  const h = homographyRectToQuad(q, outW, outH)
  const out = new Uint8ClampedArray(outW * outH * 4)
  if (!h) return { data: out, width: outW, height: outH }
  const [h11, h12, h13, h21, h22, h23, h31, h32] = h
  const sw = src.width; const sh = src.height; const sd = src.data
  let o = 0
  for (let v = 0; v < outH; v++) {
    const vv = v + 0.5
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5
      const den = h31 * uu + h32 * vv + 1
      let x = (h11 * uu + h12 * vv + h13) / den - 0.5
      let y = (h21 * uu + h22 * vv + h23) / den - 0.5
      if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1
      if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1
      const x0 = Math.floor(x); const y0 = Math.floor(y)
      const x1 = x0 + 1 < sw ? x0 + 1 : x0; const y1 = y0 + 1 < sh ? y0 + 1 : y0
      const fx = x - x0; const fy = y - y0
      const i00 = (y0 * sw + x0) * 4; const i10 = (y0 * sw + x1) * 4; const i01 = (y1 * sw + x0) * 4; const i11 = (y1 * sw + x1) * 4
      const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy
      out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11
      out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11
      out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11
      out[o + 3] = 255
      o += 4
    }
  }
  return { data: out, width: outW, height: outH }
}
