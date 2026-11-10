/**
 * Drawn test pictures for the page finder: a page of one shade on a table of another, with perspective, uneven light,
 * texture and noise. Shared by the scan tests (no camera needed).
 */
import type { Quad } from '@/lib/scan/geometry'

export function rng(seed: number) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 }

export function insideQuad(q: Quad, x: number, y: number): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]; const b = q[(i + 1) % 4]
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    const s = c >= 0 ? 1 : -1
    if (sign === 0) sign = s; else if (s !== sign) return false
  }
  return true
}

export interface Opts { w?: number; h?: number; page?: number; bg?: number; noise?: number; gradient?: number; text?: boolean; texture?: boolean; seed?: number; extra?: Quad }

/** A grey picture: `page` shade inside the quad (with text lines), `bg` shade outside (with texture), lighting gradient, noise. */
export function scene(q: Quad, o: Opts = {}) {
  const { w = 160, h = 213, page = 235, bg = 70, noise = 6, gradient = 0, text = true, texture = true, seed = 1, extra } = o
  const r = rng(seed)
  const data = new Uint8ClampedArray(w * h)
  const ux = { x: q[1].x - q[0].x, y: q[1].y - q[0].y }; const uy = { x: q[3].x - q[0].x, y: q[3].y - q[0].y }
  const lx = Math.hypot(ux.x, ux.y); const ly = Math.hypot(uy.x, uy.y)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = bg + (texture ? Math.sin(y / 2.7 + x / 9) * 7 + Math.sin(x / 3.1) * 4 : 0)
      if (extra && insideQuad(extra, x, y)) v = Math.min(255, bg + 110)
      if (insideQuad(q, x, y)) {
        v = page
        if (text) {
          const px = x - q[0].x, py = y - q[0].y
          const s = (px * ux.x + py * ux.y) / (lx * lx); const t = (px * uy.x + py * uy.y) / (ly * ly)
          if (s > 0.12 && s < 0.88 && t > 0.1 && t < 0.9 && (t * ly) % 9 < 2.2) v = page - 140
        }
      }
      v += (x / w - 0.5) * gradient + (r() - 0.5) * noise * 2
      data[y * w + x] = Math.max(0, Math.min(255, v))
    }
  }
  return { data, width: w, height: h }
}

