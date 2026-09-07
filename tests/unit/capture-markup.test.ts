import { describe, it, expect } from 'vitest'
import { arrowHeadPoints, MARKUP_TOOLS } from '@/lib/captures/markup'

describe('MARKUP_TOOLS', () => {
  it('does not include a plain "box" tool — only one tool draws a filled rectangle, and it is redact', () => {
    // UX review, 2026-09-04: a look-alike box tool next to the real redact
    // tool is an affordance trap. This pins the fix at the tool-list level.
    expect(MARKUP_TOOLS).not.toContain('box')
    expect(MARKUP_TOOLS).toContain('redact')
  })
})

describe('arrowHeadPoints', () => {
  it('produces two wing points behind the arrow tip for a horizontal line', () => {
    const [left, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 })
    // Both wings sit BEHIND the tip (smaller x) and are mirrored above/below it.
    expect(left.x).toBeLessThan(100)
    expect(right.x).toBeLessThan(100)
    expect(left.y).toBeCloseTo(-right.y, 5)
  })

  it('produces symmetric wing points for a vertical line', () => {
    const [left, right] = arrowHeadPoints({ x: 0, y: 0 }, { x: 0, y: 100 })
    expect(left.y).toBeLessThan(100)
    expect(right.y).toBeLessThan(100)
    expect(left.x).toBeCloseTo(-right.x, 5)
  })

  it('does not throw or produce NaN for a zero-length line (a tap with no movement)', () => {
    const [left, right] = arrowHeadPoints({ x: 50, y: 50 }, { x: 50, y: 50 })
    expect(Number.isFinite(left.x)).toBe(true)
    expect(Number.isFinite(left.y)).toBe(true)
    expect(Number.isFinite(right.x)).toBe(true)
    expect(Number.isFinite(right.y)).toBe(true)
  })

  it('respects a custom head length', () => {
    const [leftShort] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)
    const [leftLong] = arrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 30)
    const distShort = Math.abs(100 - leftShort.x)
    const distLong = Math.abs(100 - leftLong.x)
    expect(distLong).toBeGreaterThan(distShort)
  })
})
