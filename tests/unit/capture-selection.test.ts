import { describe, it, expect } from 'vitest'
import { rectFromTwoPoints, isSelectionLargeEnough, MIN_SELECTION_SIZE } from '@/lib/captures/selection'

const bounds = { width: 1000, height: 800 }

describe('rectFromTwoPoints', () => {
  it('normalizes top-left-to-bottom-right order', () => {
    const rect = rectFromTwoPoints({ x: 10, y: 20 }, { x: 110, y: 220 }, bounds)
    expect(rect).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('normalizes bottom-right-to-top-left order (opposite tap direction) to the SAME rect', () => {
    const forward = rectFromTwoPoints({ x: 10, y: 20 }, { x: 110, y: 220 }, bounds)
    const backward = rectFromTwoPoints({ x: 110, y: 220 }, { x: 10, y: 20 }, bounds)
    expect(backward).toEqual(forward)
  })

  it('normalizes a top-right-to-bottom-left tap order', () => {
    const rect = rectFromTwoPoints({ x: 300, y: 50 }, { x: 100, y: 250 }, bounds)
    expect(rect).toEqual({ x: 100, y: 50, width: 200, height: 200 })
  })

  it('clamps a rect that would extend past the right/bottom edge', () => {
    const rect = rectFromTwoPoints({ x: 950, y: 750 }, { x: 1200, y: 900 }, bounds)
    expect(rect.x).toBe(950)
    expect(rect.y).toBe(750)
    expect(rect.width).toBe(50) // 1000 - 950
    expect(rect.height).toBe(50) // 800 - 750
  })

  it('clamps negative coordinates to 0', () => {
    const rect = rectFromTwoPoints({ x: -50, y: -20 }, { x: 100, y: 100 }, bounds)
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
  })

  it('produces a zero-size rect for two identical points', () => {
    const rect = rectFromTwoPoints({ x: 50, y: 50 }, { x: 50, y: 50 }, bounds)
    expect(rect).toEqual({ x: 50, y: 50, width: 0, height: 0 })
  })
})

describe('isSelectionLargeEnough', () => {
  it('rejects a rect at exactly the minimum minus one pixel', () => {
    expect(isSelectionLargeEnough({ x: 0, y: 0, width: MIN_SELECTION_SIZE - 1, height: MIN_SELECTION_SIZE })).toBe(false)
    expect(isSelectionLargeEnough({ x: 0, y: 0, width: MIN_SELECTION_SIZE, height: MIN_SELECTION_SIZE - 1 })).toBe(false)
  })

  it('accepts a rect exactly at the minimum', () => {
    expect(isSelectionLargeEnough({ x: 0, y: 0, width: MIN_SELECTION_SIZE, height: MIN_SELECTION_SIZE })).toBe(true)
  })

  it('rejects a zero-size rect (a stray tap)', () => {
    expect(isSelectionLargeEnough({ x: 10, y: 10, width: 0, height: 0 })).toBe(false)
  })

  it('accepts a normal, real selection', () => {
    expect(isSelectionLargeEnough({ x: 0, y: 0, width: 300, height: 150 })).toBe(true)
  })
})
