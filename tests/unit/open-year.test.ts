/** Portal open-year picker — the Dynamiq-2024 amendment case. */
import { describe, it, expect } from 'vitest'
import { pickOpenYear } from '@/lib/portal/open-year'

describe('pickOpenYear', () => {
  it('no open years → null (page redirects, unchanged behavior)', () => {
    expect(pickOpenYear([], undefined)).toBeNull()
  })
  it('single open year → that year regardless of the param', () => {
    expect(pickOpenYear([2025], undefined)).toBe(2025)
    expect(pickOpenYear([2025], '2024')).toBe(2025)
  })
  it('several open years default to the newest', () => {
    expect(pickOpenYear([2025, 2024], undefined)).toBe(2025)
  })
  it('a requested OPEN year wins (the amendment case)', () => {
    expect(pickOpenYear([2025, 2024], '2024')).toBe(2024)
  })
  it('a requested year that is NOT open falls back to newest — no probing closed years', () => {
    expect(pickOpenYear([2025, 2024], '2023')).toBe(2025)
    expect(pickOpenYear([2025, 2024], 'abc')).toBe(2025)
  })
})
