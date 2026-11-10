/**
 * Scan document: sharpening a rough page outline (refineQuad in lib/scan/detect-page).
 * The finder works on a ~160 px picture, so its corners are a few pixels off; refining on a bigger picture
 * must bring them within about a pixel of the real corners.
 */
import { describe, expect, it } from 'vitest'
import { detectPage, refineQuad, toSmallGray } from '@/lib/scan/detect-page'
import { dist, type Point, type Quad } from '@/lib/scan/geometry'
import { scene } from '../fixtures/scan-scene'

const P = (x: number, y: number): Point => ({ x, y })
const worst = (found: Quad, truth: Quad) => Math.max(...truth.map((p, i) => dist(p, found[i])))
const nudge = (q: Quad, dx: number, dy: number): Quad => q.map((p, i) => P(p.x + (i % 2 ? -dx : dx), p.y + (i < 2 ? -dy : dy))) as Quad

// the 160 px test page, drawn at 4x size
const truth: Quad = [P(112, 120), P(520, 88), P(552, 740), P(80, 712)]

describe('refineQuad', () => {
  const big = scene(truth, { w: 640, h: 852, seed: 4 })

  it('pulls rough corners (several pixels off) to within about a pixel', () => {
    const rough = nudge(truth, 9, 7)
    expect(worst(rough, truth)).toBeGreaterThan(8)
    const fine = refineQuad(big, rough)
    expect(worst(fine, truth)).toBeLessThan(2)
  })

  it('works from what the page finder really returns on the small picture', () => {
    const { gray, scale } = toSmallGray({ data: rgbaOf(big), width: big.width, height: big.height }, 160)
    const found = detectPage(gray)!
    expect(found).not.toBeNull()
    const rough = found.quad.map(p => P(p.x / scale, p.y / scale)) as Quad
    const fine = refineQuad(big, rough)
    expect(worst(fine, truth)).toBeLessThanOrEqual(worst(rough, truth))
    expect(worst(fine, truth)).toBeLessThan(2.5)
  })

  it('still works with uneven light and noise', () => {
    const noisy = scene(truth, { w: 640, h: 852, seed: 9, gradient: 50, noise: 12 })
    expect(worst(refineQuad(noisy, nudge(truth, 8, 8)), truth)).toBeLessThan(3)
  })

  it('is not fooled by writing near the page edge', () => {
    // the scene draws writing lines inside the page; a rough outline slightly OUTSIDE must still land on the page edge
    expect(worst(refineQuad(big, nudge(truth, -10, -10)), truth)).toBeLessThan(3)
  })

  it('keeps the rough outline when there is nothing to measure (a flat picture)', () => {
    const flat = { data: new Uint8ClampedArray(640 * 852).fill(120), width: 640, height: 852 }
    const rough = nudge(truth, 4, 4)
    const out = refineQuad(flat, rough)
    expect(worst(out, rough)).toBeLessThan(0.5)
  })

  it('never wanders far from the rough outline', () => {
    const out = refineQuad(big, nudge(truth, 40, 40))
    expect(worst(out, nudge(truth, 40, 40))).toBeLessThan(40) // bounded; no corner jumps across the page
  })
})

function rgbaOf(g: { data: Uint8ClampedArray; width: number; height: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.width * g.height * 4)
  for (let i = 0; i < g.width * g.height; i++) { out[i * 4] = g.data[i]; out[i * 4 + 1] = g.data[i]; out[i * 4 + 2] = g.data[i]; out[i * 4 + 3] = 255 }
  return out
}
