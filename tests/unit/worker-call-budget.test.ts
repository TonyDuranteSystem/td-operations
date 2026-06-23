import { describe, it, expect } from 'vitest'
import { callTimeoutForBudget } from '@/lib/ai-agent/worker-tools'

// The per-call timeout must shrink as the loop's wall-clock budget depletes, so a
// late call can never push the serverless function past its hard maxDuration.
const BUDGET = 250_000
const MAX_CALL = 240_000
const MIN = 15_000

describe('callTimeoutForBudget', () => {
  it('gives a near-full timeout early in the loop (capped at maxCall)', () => {
    expect(callTimeoutForBudget(0, BUDGET, MAX_CALL)).toBe(MAX_CALL)
    expect(callTimeoutForBudget(5_000, BUDGET, MAX_CALL)).toBe(MAX_CALL)
  })

  it('shrinks the timeout as the budget depletes', () => {
    // 100s elapsed → 250-100-5 = 145s remaining (< maxCall) → 145s
    expect(callTimeoutForBudget(100_000, BUDGET, MAX_CALL)).toBe(145_000)
  })

  it('never returns less than the minimum, even at/past the deadline', () => {
    expect(callTimeoutForBudget(249_000, BUDGET, MAX_CALL)).toBe(MIN)
    expect(callTimeoutForBudget(300_000, BUDGET, MAX_CALL)).toBe(MIN)
  })

  it('a late call cannot overrun the function cap (timeout + elapsed stays < 300s)', () => {
    for (let elapsed = 0; elapsed < BUDGET; elapsed += 10_000) {
      const t = callTimeoutForBudget(elapsed, BUDGET, MAX_CALL)
      // worst case: this call runs its full timeout starting now.
      expect(elapsed + t).toBeLessThanOrEqual(300_000)
    }
  })
})
