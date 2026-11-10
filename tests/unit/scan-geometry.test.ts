/**
 * Scan document: the shapes (lib/scan/geometry) — ordering corners, sizing the straightened page, and the
 * perspective straightening itself.
 */
import { describe, expect, it } from 'vitest'
import {
  clampQuad, cornerAngle, defaultQuad, homographyRectToQuad, isConvexQuad, orderQuad, outputSize, polygonArea, quadArea, quadSides, scaleQuad, solveLinear, warpPerspective,
  type Point, type Quad, type Raster,
} from '@/lib/scan/geometry'

const P = (x: number, y: number): Point => ({ x, y })

describe('orderQuad', () => {
  it('puts any shuffle into top-left, top-right, bottom-right, bottom-left', () => {
    const want: Quad = [P(10, 10), P(90, 14), P(95, 120), P(8, 110)]
    for (const shuffled of [[want[2], want[0], want[3], want[1]], [want[3], want[2], want[1], want[0]], [want[1], want[3], want[0], want[2]]]) {
      expect(orderQuad(shuffled)).toEqual(want)
    }
  })

  it('refuses anything but four points', () => {
    expect(() => orderQuad([P(0, 0), P(1, 1)])).toThrow()
  })
})

describe('measures', () => {
  const rect: Quad = [P(0, 0), P(100, 0), P(100, 50), P(0, 50)]
  it('area, sides and angles of a rectangle', () => {
    expect(quadArea(rect)).toBe(5000)
    expect(polygonArea([P(0, 0), P(4, 0), P(0, 3)])).toBe(6)
    expect(quadSides(rect)).toEqual({ top: 100, right: 50, bottom: 100, left: 50 })
    for (let i = 0; i < 4; i++) expect(cornerAngle(rect, i)).toBeCloseTo(90)
  })

  it('knows a proper shape from a bow-tie and from a flat one', () => {
    expect(isConvexQuad(rect)).toBe(true)
    expect(isConvexQuad([P(0, 0), P(100, 50), P(100, 0), P(0, 50)])).toBe(false)
    expect(isConvexQuad([P(0, 0), P(50, 0), P(100, 0), P(0, 0)])).toBe(false)
  })

  it('default quad sits inside the picture; clamp keeps corners inside', () => {
    const d = defaultQuad(200, 100, 0.1)
    expect(d[0]).toEqual(P(20, 10))
    expect(d[2]).toEqual(P(180, 90))
    const c = clampQuad([P(-5, -5), P(300, 0), P(300, 200), P(0, 200)], 200, 100)
    expect(c.every(p => p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 100)).toBe(true)
  })

  it('scales a quad', () => {
    expect(scaleQuad(rect, 2)[2]).toEqual(P(200, 100))
    expect(scaleQuad(rect, 2, 3)[2]).toEqual(P(200, 150))
  })
})

describe('outputSize', () => {
  it('uses the longer side of each pair, so nothing is thrown away', () => {
    expect(outputSize([P(0, 0), P(100, 0), P(120, 200), P(0, 180)], 5000)).toEqual({ width: 122, height: 201 }) // bottom 121.7 beats top 100, right 201 beats left 180
  })

  it('shrinks to the cap, keeping the shape, and never goes below 2 pixels', () => {
    const o = outputSize([P(0, 0), P(4000, 0), P(4000, 2000), P(0, 2000)], 2000)
    expect(o).toEqual({ width: 2000, height: 1000 })
    expect(outputSize([P(0, 0), P(0.1, 0), P(0.1, 0.1), P(0, 0.1)], 2000)).toEqual({ width: 2, height: 2 })
  })
})

describe('solveLinear', () => {
  it('solves a small system', () => {
    const x = solveLinear([[2, 1], [1, 3]], [5, 10])!
    expect(x[0]).toBeCloseTo(1); expect(x[1]).toBeCloseTo(3)
  })
  it('says null when there is no single answer', () => {
    expect(solveLinear([[1, 2], [2, 4]], [3, 6])).toBeNull()
  })
})

describe('perspective straightening', () => {
  /** a 100x100 picture whose red channel is x and green channel is y, so any pixel tells where it came from */
  function coords(w = 100, h = 100): Raster {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = x * 2; data[i + 1] = y * 2; data[i + 2] = 0; data[i + 3] = 255 }
    return { data, width: w, height: h }
  }

  it('the rectangle-to-quad map sends the corners where asked', () => {
    const q: Quad = [P(10, 20), P(90, 10), P(95, 80), P(5, 90)]
    const h = homographyRectToQuad(q, 200, 300)!
    const map = (u: number, v: number) => { const d = h[6] * u + h[7] * v + 1; return P((h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d) }
    const targets = [[0, 0], [200, 0], [200, 300], [0, 300]] as const
    targets.forEach(([u, v], i) => { const m = map(u, v); expect(m.x).toBeCloseTo(q[i].x, 5); expect(m.y).toBeCloseTo(q[i].y, 5) })
  })

  it('cutting out the whole picture returns it unchanged', () => {
    const src = coords()
    const out = warpPerspective(src, [P(0, 0), P(100, 0), P(100, 100), P(0, 100)], 100, 100)
    for (const [x, y] of [[0, 0], [50, 50], [99, 99], [10, 80]]) {
      const i = (y * 100 + x) * 4
      expect(Math.abs(out.data[i] - src.data[i])).toBeLessThanOrEqual(2)
      expect(Math.abs(out.data[i + 1] - src.data[i + 1])).toBeLessThanOrEqual(2)
    }
  })

  it('cuts out the part inside a quad (the centre of the cut is the centre of the quad)', () => {
    const src = coords()
    const q: Quad = [P(20, 20), P(80, 20), P(80, 60), P(20, 60)]
    const out = warpPerspective(src, q, 60, 40)
    const mid = ((20 * 60) + 30) * 4
    expect(Math.abs(out.data[mid] - 50 * 2)).toBeLessThanOrEqual(3) // x = 50
    expect(Math.abs(out.data[mid + 1] - 40 * 2)).toBeLessThanOrEqual(3) // y = 40
  })

  it('straightens a skewed page: its corners land on the corners of the result', () => {
    const src = coords()
    const q: Quad = [P(15, 10), P(85, 25), P(80, 90), P(10, 70)]
    const out = warpPerspective(src, q, 70, 80)
    const at = (x: number, y: number) => { const i = (y * 70 + x) * 4; return [out.data[i] / 2, out.data[i + 1] / 2] }
    const tl = at(0, 0), br = at(69, 79)
    expect(Math.hypot(tl[0] - 15, tl[1] - 10)).toBeLessThan(3)
    expect(Math.hypot(br[0] - 80, br[1] - 90)).toBeLessThan(3)
  })

  it('returns a blank picture, not a crash, for degenerate corners', () => {
    const out = warpPerspective(coords(), [P(1, 1), P(1, 1), P(1, 1), P(1, 1)], 10, 10)
    expect(out.width).toBe(10)
    expect(out.data.length).toBe(400)
  })
})
