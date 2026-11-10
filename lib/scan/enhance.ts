/**
 * Scan document: the three looks a page can have after it is straightened.
 *   colour    — real colours, only the brightness is evened out (passport photo pages, IDs)
 *   grey      — the same in shades of grey
 *   document  — sharp dark writing on clean white paper: uneven lighting and shadows are taken out
 * Pure maths on RGBA pictures, so it is tested without a browser. Every function returns a NEW picture.
 */
import type { Raster } from './geometry'

export type ScanLook = 'colour' | 'document' | 'grey'
export const SCAN_LOOKS: ReadonlyArray<ScanLook> = ['colour', 'document', 'grey']
/** Colour first: right for a passport or an ID, one tap away from Document for letters (Antonio, 2026-11-10). */
export const DEFAULT_SCAN_LOOK: ScanLook = 'colour'

function lumaOf(src: Raster): Uint8ClampedArray {
  const n = src.width * src.height
  const g = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) g[i] = (src.data[i * 4] * 77 + src.data[i * 4 + 1] * 150 + src.data[i * 4 + 2] * 29) >> 8
  return g
}

/** The brightness below which `fraction` of the values fall. */
function percentile(values: Uint8ClampedArray, fraction: number): number {
  const bins = new Uint32Array(256)
  for (let i = 0; i < values.length; i++) bins[values[i]]++
  const target = values.length * fraction
  let acc = 0
  for (let v = 0; v < 256; v++) { acc += bins[v]; if (acc >= target) return v }
  return 255
}

/** The stretch that turns the darkest 1% into black and the brightest 1% into white (kept sane for flat pictures). */
export function levelsOf(luma: Uint8ClampedArray): { lo: number; hi: number } {
  let lo = percentile(luma, 0.01)
  let hi = percentile(luma, 0.99)
  if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 20); hi = Math.min(255, mid + 20) }
  return { lo, hi }
}

/** An estimate of the paper's own brightness at every pixel: the brightest thing nearby, smoothed. Writing is thinner than a block, so it does not pull the estimate down. */
export function paperBrightness(luma: Uint8ClampedArray, width: number, height: number): Float32Array {
  const cols = 80
  const block = Math.max(2, Math.ceil(Math.max(width, height) / cols))
  const sw = Math.ceil(width / block), sh = Math.ceil(height / block)
  const small = new Float32Array(sw * sh)
  for (let by = 0; by < sh; by++) {
    for (let bx = 0; bx < sw; bx++) {
      let m = 0
      const y1 = Math.min(height, (by + 1) * block), x1 = Math.min(width, (bx + 1) * block)
      for (let y = by * block; y < y1; y++) for (let x = bx * block; x < x1; x++) { const v = luma[y * width + x]; if (v > m) m = v }
      small[by * sw + bx] = m
    }
  }
  // one light smoothing pass
  const smooth = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let acc = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy >= 0 && xx >= 0 && yy < sh && xx < sw) { acc += small[yy * sw + xx]; n++ }
      }
      smooth[y * sw + x] = acc / n
    }
  }
  // back up to full size, smoothly
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / block - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(sh - 1, y0 + 1); const ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / block - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(sw - 1, x0 + 1); const tx = fx - x0
      const a = smooth[y0 * sw + x0] * (1 - tx) + smooth[y0 * sw + x1] * tx
      const b = smooth[y1 * sw + x0] * (1 - tx) + smooth[y1 * sw + x1] * tx
      out[y * width + x] = a * (1 - ty) + b * ty
    }
  }
  return out
}

export function applyLook(src: Raster, look: ScanLook): Raster {
  const { width, height } = src
  const n = width * height
  const out = new Uint8ClampedArray(n * 4)
  const luma = lumaOf(src)

  if (look === 'document') {
    const paper = paperBrightness(luma, width, height)
    // ratio 1 = as bright as the paper around it. Below ~0.6 is writing, above ~0.93 is paper.
    const LO = 0.6, HI = 0.93
    for (let i = 0; i < n; i++) {
      const ratio = luma[i] / Math.max(40, paper[i])
      let v = (ratio - LO) / (HI - LO)
      v = v < 0 ? 0 : v > 1 ? 1 : v
      const o = Math.round(v * v * (3 - 2 * v) * 255) // smooth step, crisp but not jagged
      out[i * 4] = o; out[i * 4 + 1] = o; out[i * 4 + 2] = o; out[i * 4 + 3] = 255
    }
    return { data: out, width, height }
  }

  const { lo, hi } = levelsOf(luma)
  const k = 255 / Math.max(1, hi - lo)
  if (look === 'grey') {
    for (let i = 0; i < n; i++) {
      const v = (luma[i] - lo) * k
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255
    }
    return { data: out, width, height }
  }
  // colour: the same stretch on all three channels, so the colours keep their balance
  for (let i = 0; i < n; i++) {
    out[i * 4] = (src.data[i * 4] - lo) * k
    out[i * 4 + 1] = (src.data[i * 4 + 1] - lo) * k
    out[i * 4 + 2] = (src.data[i * 4 + 2] - lo) * k
    out[i * 4 + 3] = 255
  }
  return { data: out, width, height }
}
