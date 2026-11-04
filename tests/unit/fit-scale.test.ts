import { describe, it, expect } from 'vitest'
import { fitScale, MIN_FIT_SCALE } from '@/lib/inbox/fit-scale'

// Shrinking a too-wide email to the phone's width (TD Social app, Step 1b).
describe('fitScale', () => {
  it('leaves an email that already fits alone (a couple of pixels of slack is fine)', () => {
    expect(fitScale(320, 390)).toBe(1)
    expect(fitScale(390, 390)).toBe(1)
    expect(fitScale(392, 390)).toBe(1)
  })

  it('shrinks a wider email to exactly the available width', () => {
    expect(fitScale(780, 390)).toBeCloseTo(0.5, 5)
    expect(fitScale(600, 390)).toBeCloseTo(0.65, 5)
  })

  it('never grows an email and never goes below the readable floor', () => {
    expect(fitScale(100, 390)).toBe(1)
    expect(fitScale(5000, 390)).toBe(MIN_FIT_SCALE)
  })

  it('does nothing for numbers that make no sense', () => {
    expect(fitScale(0, 390)).toBe(1)
    expect(fitScale(600, 0)).toBe(1)
    expect(fitScale(NaN, 390)).toBe(1)
    expect(fitScale(600, Infinity)).toBe(1)
    expect(fitScale(-5, 390)).toBe(1)
  })
})
