import { describe, it, expect } from 'vitest'
import {
  clamp01,
  clampNormalizedRect,
  isValidNormalizedRect,
  domBoxToNormalized,
  normalizedToDomBox,
  expandDomBoxToMinimum,
  normalizedToPdfRect,
  type NormalizedRect,
} from '@/lib/esign/coordinates'

// US Letter portrait in points.
const W = 612
const H = 792

describe('clamp01', () => {
  it('clamps below/above and passes NaN→0', () => {
    expect(clamp01(-0.2)).toBe(0)
    expect(clamp01(1.3)).toBe(1)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(NaN)).toBe(0)
  })
})

describe('normalizedToPdfRect — the Y-flip (load-bearing)', () => {
  it('top-left field maps to the TOP-left of the page in pdf-lib points', () => {
    // A box at the very top-left, 20% wide, 5% tall.
    const r: NormalizedRect = { pos_x: 0, pos_y: 0, width: 0.2, height: 0.05 }
    const p = normalizedToPdfRect(r, W, H)
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.width).toBeCloseTo(0.2 * W, 6)
    expect(p.height).toBeCloseTo(0.05 * H, 6)
    // bottom edge = pageHeight - top(0) - height
    expect(p.y).toBeCloseTo(H - 0.05 * H, 6)
  })

  it('bottom-left field (pos_y near 1) maps to y≈0 (page bottom)', () => {
    const r: NormalizedRect = { pos_x: 0, pos_y: 0.95, width: 0.2, height: 0.05 }
    const p = normalizedToPdfRect(r, W, H)
    expect(p.y).toBeCloseTo(0, 6) // sits on the page bottom
  })

  it('bottom-right corner maps to the right edge and y=0', () => {
    const r: NormalizedRect = { pos_x: 0.8, pos_y: 0.9, width: 0.2, height: 0.1 }
    const p = normalizedToPdfRect(r, W, H)
    expect(p.x).toBeCloseTo(0.8 * W, 6)
    expect(p.x + p.width).toBeCloseTo(W, 6)
    expect(p.y).toBeCloseTo(0, 6)
  })

  it('center field is centered after the flip', () => {
    const r: NormalizedRect = { pos_x: 0.4, pos_y: 0.45, width: 0.2, height: 0.1 }
    const p = normalizedToPdfRect(r, W, H)
    // box vertical center in points, measured from bottom
    const centerY = p.y + p.height / 2
    // top-origin center fraction 0.5 → from bottom that's also 0.5
    expect(centerY).toBeCloseTo(0.5 * H, 6)
    expect(p.x + p.width / 2).toBeCloseTo(0.5 * W, 6)
  })

  it('throws on non-positive page size', () => {
    const r: NormalizedRect = { pos_x: 0, pos_y: 0, width: 0.2, height: 0.05 }
    expect(() => normalizedToPdfRect(r, 0, H)).toThrow(/positive/)
    expect(() => normalizedToPdfRect(r, W, -1)).toThrow(/positive/)
  })

  it('refuses rotated pages rather than misplacing the field', () => {
    const r: NormalizedRect = { pos_x: 0, pos_y: 0, width: 0.2, height: 0.05 }
    expect(() => normalizedToPdfRect(r, W, H, 90)).toThrow(/rotated/)
    expect(() => normalizedToPdfRect(r, W, H, 270)).toThrow(/rotated/)
    // 0 and 360 are fine
    expect(() => normalizedToPdfRect(r, W, H, 0)).not.toThrow()
    expect(() => normalizedToPdfRect(r, W, H, 360)).not.toThrow()
  })
})

describe('editor round-trip (dom ↔ normalized) is zoom-independent', () => {
  it('round-trips at one zoom', () => {
    const layerW = 800
    const layerH = 1035
    const box = { left: 160, top: 51.75, width: 200, height: 20 }
    const norm = domBoxToNormalized(box, layerW, layerH)
    const back = normalizedToDomBox(norm, layerW, layerH)
    expect(back.left).toBeCloseTo(box.left, 6)
    expect(back.top).toBeCloseTo(box.top, 6)
    expect(back.width).toBeCloseTo(box.width, 6)
    expect(back.height).toBeCloseTo(box.height, 6)
  })

  it('same normalized rect renders proportionally at a different zoom (glued to the page)', () => {
    const norm: NormalizedRect = { pos_x: 0.25, pos_y: 0.1, width: 0.25, height: 0.02 }
    const small = normalizedToDomBox(norm, 400, 518)
    const large = normalizedToDomBox(norm, 800, 1036)
    // doubling the layer doubles the pixel box — placement stays correct at any zoom
    expect(large.left).toBeCloseTo(small.left * 2, 6)
    expect(large.top).toBeCloseTo(small.top * 2, 6)
    expect(large.width).toBeCloseTo(small.width * 2, 6)
  })

  it('throws on non-positive layer size', () => {
    expect(() => domBoxToNormalized({ left: 0, top: 0, width: 10, height: 10 }, 0, 100)).toThrow(/positive/)
  })
})

describe('clampNormalizedRect — keep fields on the page', () => {
  it('pulls a field that overflows the right/bottom edge back on-page', () => {
    const r: NormalizedRect = { pos_x: 0.9, pos_y: 0.95, width: 0.3, height: 0.2 }
    const c = clampNormalizedRect(r)
    expect(c.pos_x + c.width).toBeLessThanOrEqual(1 + 1e-9)
    expect(c.pos_y + c.height).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('clamps negative positions to 0', () => {
    const c = clampNormalizedRect({ pos_x: -0.1, pos_y: -0.5, width: 0.2, height: 0.1 })
    expect(c.pos_x).toBe(0)
    expect(c.pos_y).toBe(0)
  })
})

describe('isValidNormalizedRect', () => {
  it('accepts an on-page rect', () => {
    expect(isValidNormalizedRect({ pos_x: 0.1, pos_y: 0.1, width: 0.2, height: 0.05 })).toBe(true)
  })
  it('rejects zero/negative size, overflow, NaN, Infinity', () => {
    expect(isValidNormalizedRect({ pos_x: 0, pos_y: 0, width: 0, height: 0.1 })).toBe(false)
    expect(isValidNormalizedRect({ pos_x: 0.9, pos_y: 0, width: 0.2, height: 0.1 })).toBe(false)
    expect(isValidNormalizedRect({ pos_x: NaN, pos_y: 0, width: 0.2, height: 0.1 })).toBe(false)
    expect(isValidNormalizedRect({ pos_x: 0, pos_y: 0, width: Infinity, height: 0.1 })).toBe(false)
  })
})

describe('expandDomBoxToMinimum — the unhittable signature strip', () => {
  // The real production case: Adam Marra / Azor Consulting, 8-page tax return,
  // signature at pos_y 0.869 with height 0.0164 → a ~13px strip on an 800px-wide
  // render. He never found it and the submit button stayed disabled.
  const LAYER_W = 800
  const LAYER_H = 1035

  it('grows the real 13px signature strip into a hittable box, centred on the same spot', () => {
    const raw = normalizedToDomBox({ pos_x: 0.1397, pos_y: 0.8694, width: 0.1898, height: 0.0164 }, LAYER_W, LAYER_H)
    expect(raw.height).toBeLessThan(20) // the bug: unhittable as stored

    const grown = expandDomBoxToMinimum(raw, 80, 36, LAYER_W, LAYER_H)
    expect(grown.height).toBe(36)
    // Already wider than the minimum — width must be left alone so it cannot run
    // into the date field on the same signature line.
    expect(grown.width).toBeCloseTo(raw.width, 6)
    // Same centre: the client is pointed at the form's own signature line.
    expect(grown.top + grown.height / 2).toBeCloseTo(raw.top + raw.height / 2, 6)
    expect(grown.left + grown.width / 2).toBeCloseTo(raw.left + raw.width / 2, 6)
  })

  it('never shrinks a box that is already big enough', () => {
    const big = { left: 100, top: 100, width: 300, height: 90 }
    expect(expandDomBoxToMinimum(big, 80, 36, LAYER_W, LAYER_H)).toEqual(big)
  })

  it('slides back inside the page instead of overflowing at the edges', () => {
    const atTop = { left: 0, top: 0, width: 20, height: 4 }
    const grown = expandDomBoxToMinimum(atTop, 80, 36, LAYER_W, LAYER_H)
    expect(grown.left).toBe(0)
    expect(grown.top).toBe(0)

    const atBottomRight = { left: LAYER_W - 20, top: LAYER_H - 4, width: 20, height: 4 }
    const g2 = expandDomBoxToMinimum(atBottomRight, 80, 36, LAYER_W, LAYER_H)
    expect(g2.left + g2.width).toBeLessThanOrEqual(LAYER_W)
    expect(g2.top + g2.height).toBeLessThanOrEqual(LAYER_H)
  })

  it('collapses to the page when the minimum is larger than the page itself', () => {
    const g = expandDomBoxToMinimum({ left: 10, top: 10, width: 5, height: 5 }, 500, 500, 100, 80)
    expect(g.width).toBe(100)
    expect(g.height).toBe(80)
    expect(g.left).toBe(0)
    expect(g.top).toBe(0)
  })

  it('does not produce NaN from a malformed box or layer', () => {
    const g = expandDomBoxToMinimum({ left: NaN, top: 5, width: NaN, height: 5 }, 80, 36, LAYER_W, LAYER_H)
    expect(Number.isFinite(g.left)).toBe(true)
    expect(Number.isFinite(g.top)).toBe(true)
    expect(Number.isFinite(g.width)).toBe(true)
    expect(Number.isFinite(g.height)).toBe(true)
  })
})
