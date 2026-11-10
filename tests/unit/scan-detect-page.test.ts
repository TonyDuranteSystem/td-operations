/**
 * Scan document: finding the page in a camera picture (lib/scan/detect-page).
 * No camera in the tests: pictures are drawn here — a page of a given shade on a table of another, with perspective,
 * lighting gradients, texture and noise — and the four corners must come back in the right places.
 */
import { describe, expect, it } from 'vitest'
import { detectPage, toSmallGray } from '@/lib/scan/detect-page'
import { dist, type Point, type Quad } from '@/lib/scan/geometry'
import { scene } from '../fixtures/scan-scene'

/** the corners found vs the corners drawn: the worst distance, in picture pixels */
const worstError = (found: Quad, truth: Quad) => Math.max(...truth.map((p, i) => dist(p, found[i])))

const P = (x: number, y: number): Point => ({ x, y })

describe('detectPage', () => {
  const page: Quad = [P(28, 30), P(130, 22), P(138, 185), P(20, 178)]

  it('finds a light page on a dark table, with perspective', () => {
    const f = detectPage(scene(page))
    expect(f).not.toBeNull()
    expect(worstError(f!.quad, page)).toBeLessThan(6)
  })

  it('still finds it with uneven lighting and noise', () => {
    const f = detectPage(scene(page, { gradient: 60, noise: 12, seed: 7 }))
    expect(f).not.toBeNull()
    expect(worstError(f!.quad, page)).toBeLessThan(7)
  })

  it('finds a dark card on a light table', () => {
    const card: Quad = [P(34, 60), P(128, 54), P(132, 150), P(30, 156)]
    const f = detectPage(scene(card, { page: 60, bg: 215, text: false }))
    expect(f).not.toBeNull()
    expect(worstError(f!.quad, card)).toBeLessThan(6)
  })

  it('finds a page with only a modest shade difference from the table', () => {
    const f = detectPage(scene(page, { page: 200, bg: 125, noise: 4 }))
    expect(f).not.toBeNull()
    expect(worstError(f!.quad, page)).toBeLessThan(7)
  })

  it('finds a page turned about 30 degrees', () => {
    const a = (30 * Math.PI) / 180; const cx = 80, cy = 106
    const turned = ([P(40, 40), P(120, 40), P(120, 172), P(40, 172)] as Quad).map(p => P(cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a))) as Quad
    const f = detectPage(scene(turned))
    expect(f).not.toBeNull()
    // the corners may start at another one of the four: compare as a set
    for (const p of turned) expect(Math.min(...f!.quad.map(q => dist(p, q)))).toBeLessThan(7)
  })

  it('picks the page, not a smaller bright object next to it', () => {
    const mug: Quad = [P(4, 6), P(24, 6), P(24, 24), P(4, 24)]
    const big: Quad = [P(36, 40), P(140, 40), P(140, 196), P(36, 196)]
    const f = detectPage(scene(big, { extra: mug, page: 240 }))
    expect(f).not.toBeNull()
    expect(worstError(f!.quad, big)).toBeLessThan(7)
  })

  it('says "no page" for a plain table with texture and noise', () => {
    const empty = scene(page, { page: 70, bg: 70, text: false, noise: 10, seed: 3 })
    expect(detectPage(empty)).toBeNull()
  })

  it('says "no page" for something tiny', () => {
    const tiny: Quad = [P(70, 90), P(86, 90), P(86, 108), P(70, 108)]
    expect(detectPage(scene(tiny))).toBeNull()
  })

  it('says "no page" for a picture too small to judge', () => {
    expect(detectPage({ data: new Uint8ClampedArray(64), width: 8, height: 8 })).toBeNull()
  })

  it('reports how big the page is and how sure it is', () => {
    const f = detectPage(scene(page))!
    expect(f.coverage).toBeGreaterThan(0.3)
    expect(f.coverage).toBeLessThan(0.9)
    expect(f.score).toBeGreaterThan(0.5)
  })
})

describe('toSmallGray', () => {
  it('shrinks a colour picture to a small grey one and tells the scale', () => {
    const w = 640, h = 480
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255 }
    const { gray, scale } = toSmallGray({ data: rgba, width: w, height: h }, 160)
    expect(gray.width).toBe(160)
    expect(gray.height).toBe(120)
    expect(scale).toBeCloseTo(0.25)
    expect(gray.data[0]).toBeGreaterThan(250)
  })

  it('does not enlarge a small picture', () => {
    const { gray, scale } = toSmallGray({ data: new Uint8ClampedArray(40 * 30 * 4), width: 40, height: 30 }, 160)
    expect(gray.width).toBe(40)
    expect(scale).toBe(1)
  })
})
