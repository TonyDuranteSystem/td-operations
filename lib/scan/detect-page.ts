/**
 * Scan document: finding the page in a camera picture. Pure maths on a small grey picture (about 160 pixels wide),
 * so it runs several times a second on a phone and can be tested without a camera.
 *
 * Two ways of spotting a page are tried and the better one wins:
 *   - EDGES: the strong lines of the picture, joined up; the biggest joined shape is the page outline.
 *   - REGION: the biggest bright (or dark) patch, for a page that stands out from the table by shade.
 * Either way the shape is boiled down to four corners, and the result is only trusted when the lines around
 * those four corners really are edges in the picture ("edge support"). A picture with no clear page gives null,
 * and the screen then lets the person drag the corners.
 */
import { cornerAngle, isConvexQuad, orderQuad, polygonArea, quadSides, type Point, type Quad } from './geometry'

export interface GrayImage { data: Uint8ClampedArray | Uint8Array; width: number; height: number }
export interface PageFound { quad: Quad; /** 0..1, how sure we are */ score: number; /** the share of the picture the page covers */ coverage: number }

/** A page smaller or bigger than this share of the picture is not a page we believe. */
export const MIN_COVERAGE = 0.12
export const MAX_COVERAGE = 0.97
/** Real pages score 0.9 and up in the tests; noise and texture score about 0.5. */
export const MIN_SCORE = 0.75

/** Box blur, radius r, edges clamped. */
function boxBlur(src: Uint8ClampedArray | Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Float32Array(w * h)
  const out = new Uint8Array(w * h)
  const k = 2 * r + 1
  for (let y = 0; y < h; y++) {
    let acc = 0
    for (let i = -r; i <= r; i++) acc += src[y * w + Math.min(w - 1, Math.max(0, i))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / k
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

/** Edge strength (|gx| + |gy| of a Sobel), border pixels left at 0. */
function sobel(g: Uint8Array, w: number, h: number): Uint16Array {
  const mag = new Uint16Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], gg = g[i + w - 1], hh = g[i + w], ii = g[i + w + 1]
      const gx = (c + 2 * f + ii) - (a + 2 * d + gg)
      const gy = (gg + 2 * hh + ii) - (a + 2 * b + c)
      mag[i] = Math.abs(gx) + Math.abs(gy)
    }
  }
  return mag
}

/** The strength below which `fraction` of the pixels fall. */
function percentile(values: Uint16Array, fraction: number): number {
  const bins = new Uint32Array(256)
  for (let i = 0; i < values.length; i++) bins[Math.min(255, values[i] >> 3)]++
  const target = values.length * fraction
  let acc = 0
  for (let b = 0; b < 256; b++) { acc += bins[b]; if (acc >= target) return (b + 1) << 3 }
  return 2040
}

/** Otsu's cut-off between dark and bright, looking only at pixel values from `lo` to `hi`. */
function otsu(g: Uint8Array, lo = 0, hi = 255): number {
  const hist = new Uint32Array(256)
  let total = 0
  for (let i = 0; i < g.length; i++) { const v = g[i]; if (v >= lo && v <= hi) { hist[v]++; total++ } }
  if (total === 0) return Math.floor((lo + hi) / 2)
  let sum = 0
  for (let t = lo; t <= hi; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = -1, thr = Math.floor((lo + hi) / 2)
  for (let t = lo; t <= hi; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB; const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = t }
  }
  return thr
}

function dilate3(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue
          if (src[yy * w + xx]) { on = 1; break }
        }
      }
      out[y * w + x] = on
    }
  }
  return out
}

interface Component { pixels: Int32Array; count: number; touchesBorder: boolean }

/** 8-connected groups of "on" pixels, biggest first (only the biggest `keep`). */
function components(mask: Uint8Array, w: number, h: number, minCount: number, keep: number): Component[] {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const order = new Int32Array(w * h)
  const found: Component[] = []
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0; let n = 0
    stack[sp++] = start; seen[start] = 1
    let touches = false
    while (sp > 0) {
      const p = stack[--sp]
      order[n++] = p
      const x = p % w; const y = (p - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx; if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q }
        }
      }
    }
    if (n >= minCount) found.push({ pixels: order.slice(0, n), count: n, touchesBorder: touches })
  }
  found.sort((a, b) => b.count - a.count)
  return found.slice(0, keep)
}

/** Convex hull (Andrew's monotone chain) of the outer edge of a component: the extreme pixel of every row and column. */
function hullOf(c: Component, w: number, h: number): Point[] {
  const minX = new Int32Array(h).fill(1 << 30), maxX = new Int32Array(h).fill(-1)
  const minY = new Int32Array(w).fill(1 << 30), maxY = new Int32Array(w).fill(-1)
  for (let i = 0; i < c.pixels.length; i++) {
    const p = c.pixels[i]; const x = p % w; const y = (p - x) / w
    if (x < minX[y]) minX[y] = x
    if (x > maxX[y]) maxX[y] = x
    if (y < minY[x]) minY[x] = y
    if (y > maxY[x]) maxY[x] = y
  }
  const pts: Point[] = []
  for (let y = 0; y < h; y++) if (maxX[y] >= 0) { pts.push({ x: minX[y], y }); pts.push({ x: maxX[y], y }) }
  for (let x = 0; x < w; x++) if (maxY[x] >= 0) { pts.push({ x, y: minY[x] }); pts.push({ x, y: maxY[x] }) }
  pts.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p) }
  const upper: Point[] = []
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p) }
  lower.pop(); upper.pop()
  return lower.concat(upper)
}

/** Boils a convex outline down to four corners by dropping, one at a time, the corner that changes the shape least. */
function simplifyToFour(hull: Point[]): Point[] | null {
  if (hull.length < 4) return null
  const pts = hull.slice()
  while (pts.length > 4) {
    let best = 0, bestArea = Infinity
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]; const b = pts[i]; const c = pts[(i + 1) % pts.length]
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
      if (area < bestArea) { bestArea = area; best = i }
    }
    pts.splice(best, 1)
  }
  return pts
}

interface EdgeMap { map: Uint8Array; /** share of pixels that are "edge" */ density: number }

/**
 * How much of the outline of `q` lies on an edge of the picture (0..1): the mean of the four sides, pulled down by the
 * weakest one, and measured above chance — in a noisy picture most pixels are "edge", so lying on one proves nothing.
 */
function edgeSupport(q: Quad, edgeMap: EdgeMap, w: number, h: number): number {
  const edges = edgeMap.map
  const fractions: number[] = []
  for (let s = 0; s < 4; s++) {
    const a = q[s]; const b = q[(s + 1) % 4]
    const len = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    let hit = 0
    for (let i = 0; i <= len; i++) {
      const x = Math.round(a.x + ((b.x - a.x) * i) / len); const y = Math.round(a.y + ((b.y - a.y) * i) / len)
      let on = false
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && edges[yy * w + xx]) { on = true; break }
      }
      if (on) hit++
    }
    fractions.push(hit / (len + 1))
  }
  const mean = fractions.reduce((p, c) => p + c, 0) / 4
  const raw = 0.5 * mean + 0.5 * Math.min(...fractions)
  const chance = Math.min(0.95, edgeMap.density)
  return Math.max(0, (raw - chance) / (1 - chance))
}

function judge(hull: Point[], edges: EdgeMap, w: number, h: number): PageFound | null {
  const four = simplifyToFour(hull)
  if (!four) return null
  const q = orderQuad(four)
  if (!isConvexQuad(q)) return null
  const coverage = polygonArea(q) / (w * h)
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null
  for (let i = 0; i < 4; i++) { const a = cornerAngle(q, i); if (a < 45 || a > 135) return null }
  const s = quadSides(q)
  if (Math.min(s.top, s.right, s.bottom, s.left) < Math.min(w, h) * 0.12) return null
  // a "page" whose corners sit on the edge of the picture is a patch of table, not a page
  const onBorder = q.filter(p => p.x <= 1.5 || p.y <= 1.5 || p.x >= w - 2.5 || p.y >= h - 2.5).length
  if (onBorder >= 3) return null
  const support = edgeSupport(q, edges, w, h)
  return { quad: q, score: support, coverage }
}

/**
 * Looks for a page. `gray` should be small (the camera loop passes about 160 pixels wide). Corners come back in
 * the pixel space of `gray`.
 */
export function detectPage(gray: GrayImage): PageFound | null {
  const { width: w, height: h } = gray
  if (w < 16 || h < 16 || gray.data.length < w * h) return null
  const g = boxBlur(boxBlur(gray.data, w, h, 1), w, h, 1)
  const mag = sobel(g, w, h)
  const candidates: PageFound[] = []

  // The outline of a page can be fainter than the writing on it, so edges are taken at two strengths.
  const edgesAt = (cut: number): EdgeMap => {
    const m = new Uint8Array(w * h)
    for (let i = 0; i < m.length; i++) if (mag[i] >= cut) m[i] = 1
    const map = dilate3(m, w, h)
    let on = 0
    for (let i = 0; i < map.length; i++) on += map[i]
    return { map, density: on / map.length }
  }
  const strong = edgesAt(Math.max(28, percentile(mag, 0.88)))
  const faint = edgesAt(Math.max(28, percentile(mag, 0.72)))

  const consider = (c: Component | undefined, edges: EdgeMap) => {
    if (!c) return
    const found = judge(hullOf(c, w, h), edges, w, h)
    if (found) candidates.push(found)
  }

  // 1. the biggest joined edge shapes
  for (const edges of [strong, faint]) {
    for (const c of components(edges.map, w, h, Math.floor(w * h * 0.01), 3)) consider(c, edges)
  }

  // 2. the biggest bright patch and the biggest dark patch, cut at the overall shade split and at the splits inside each half
  //    (a page with writing has three shades: ink, table and paper)
  const t1 = otsu(g)
  const cuts = Array.from(new Set([t1, otsu(g, t1 + 1, 255), otsu(g, 0, t1)]))
  for (const t of cuts) {
    const bright = new Uint8Array(w * h), dark = new Uint8Array(w * h)
    for (let i = 0; i < g.length; i++) { if (g[i] > t) bright[i] = 1; else dark[i] = 1 }
    for (const mask of [bright, dark]) {
      for (const c of components(mask, w, h, Math.floor(w * h * MIN_COVERAGE * 0.6), 2)) {
        if (c.count > w * h * MAX_COVERAGE) continue
        consider(c, faint)
      }
    }
  }

  if (candidates.length === 0) return null
  // bigger pages win a close call: a small shape inside the page (a logo, a table) can have clean edges too
  candidates.sort((a, b) => (b.score + 0.25 * Math.min(1, b.coverage / 0.5)) - (a.score + 0.25 * Math.min(1, a.coverage / 0.5)))
  const best = candidates[0]
  return best.score >= MIN_SCORE ? best : null
}

/** RGBA -> grey, shrunk to at most `maxWidth` wide (nearest pixel, fast enough for the camera loop). */
export function toSmallGray(rgba: { data: Uint8ClampedArray; width: number; height: number }, maxWidth = 160): { gray: GrayImage; scale: number } {
  const scale = Math.min(1, maxWidth / rgba.width)
  const w = Math.max(1, Math.round(rgba.width * scale)); const h = Math.max(1, Math.round(rgba.height * scale))
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(rgba.height - 1, Math.floor((y + 0.5) / scale))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(rgba.width - 1, Math.floor((x + 0.5) / scale))
      const i = (sy * rgba.width + sx) * 4
      out[y * w + x] = (rgba.data[i] * 77 + rgba.data[i + 1] * 150 + rgba.data[i + 2] * 29) >> 8
    }
  }
  return { gray: { data: out, width: w, height: h }, scale }
}

// ───────── precision: fit each side of the page at a higher resolution ─────────

interface Line { px: number; py: number; dx: number; dy: number }

function bilinearGray(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  const cx = Math.min(w - 1, Math.max(0, x)), cy = Math.min(h - 1, Math.max(0, y))
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1)
  const fx = cx - x0, fy = cy - y0
  return (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx) * (1 - fy) + (g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx) * fy
}

/** Straight line through points (least squares, tolerant of a few strays). Null if too few. */
function fitLine(pts: Point[]): Line | null {
  const run = (use: Point[]): Line | null => {
    if (use.length < 3) return null
    const cx = use.reduce((s, p) => s + p.x, 0) / use.length, cy = use.reduce((s, p) => s + p.y, 0) / use.length
    let sxx = 0, sxy = 0, syy = 0
    for (const p of use) { const x = p.x - cx, y = p.y - cy; sxx += x * x; sxy += x * y; syy += y * y }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    return { px: cx, py: cy, dx: Math.cos(angle), dy: Math.sin(angle) }
  }
  const first = run(pts)
  if (!first) return null
  const dists = pts.map(p => Math.abs((p.x - first.px) * first.dy - (p.y - first.py) * first.dx))
  const sorted = dists.slice().sort((a, b) => a - b)
  const cut = Math.max(1.2, 2.5 * sorted[Math.floor(sorted.length / 2)])
  return run(pts.filter((_, i) => dists[i] <= cut)) ?? first
}

function intersect(a: Line, b: Line): Point | null {
  const cross = a.dx * b.dy - a.dy * b.dx
  if (Math.abs(cross) < 1e-6) return null
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross
  return { x: a.px + a.dx * t, y: a.py + a.dy * t }
}

/**
 * Sharpens a rough page outline. The rough one comes from a tiny picture and sits a few pixels off. Here, on a bigger grey
 * picture, every side is re-measured: along many short lines across the side, find the strongest brightness step; fit a
 * straight line through those spots (dropping strays such as a line of writing near the edge); then the corners are
 * where neighbouring lines cross. A side that cannot be measured keeps its rough position, and the answer is only used
 * when it stays close to the rough outline and is still a proper four-cornered shape.
 */
export function refineQuad(gray: GrayImage, rough: Quad): Quad {
  const { width: w, height: h } = gray
  const g = boxBlur(gray.data, w, h, 1)
  const radius = Math.max(4, Math.round(Math.min(w, h) * 0.03))
  const lines: Line[] = []
  for (let s = 0; s < 4; s++) {
    const a = rough[s], b = rough[(s + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const dir = { x: (b.x - a.x) / (len || 1), y: (b.y - a.y) / (len || 1) }
    const normal = { x: dir.y, y: -dir.x }
    const count = Math.max(8, Math.min(48, Math.round(len / 10)))
    const hits: Point[] = []
    for (let i = 0; i < count; i++) {
      const t = 0.1 + (0.8 * (i + 0.5)) / count
      const bx = a.x + dir.x * len * t, by = a.y + dir.y * len * t
      let best = 0, bestScore = 0
      for (let k = -radius; k <= radius; k++) {
        const d = bilinearGray(g, w, h, bx + normal.x * (k + 1), by + normal.y * (k + 1)) - bilinearGray(g, w, h, bx + normal.x * (k - 1), by + normal.y * (k - 1))
        const score = Math.abs(d) * (1 - 0.35 * (Math.abs(k) / radius)) // a step near where we expect it beats a stronger one far away
        if (score > bestScore) { bestScore = score; best = k }
      }
      if (bestScore >= 8) hits.push({ x: bx + normal.x * best, y: by + normal.y * best })
    }
    const line = hits.length >= Math.max(4, count * 0.4) ? fitLine(hits) : null
    lines.push(line ?? { px: a.x, py: a.y, dx: dir.x, dy: dir.y })
  }
  const corners: Point[] = []
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i])
    // never wander far from the rough corner: a wild crossing means a side was measured wrongly
    corners.push(p && Math.hypot(p.x - rough[i].x, p.y - rough[i].y) <= radius * 2.2 ? p : rough[i])
  }
  const q = corners as Quad
  return isConvexQuad(q) ? q : rough
}
