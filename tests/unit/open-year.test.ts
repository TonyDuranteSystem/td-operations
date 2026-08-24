/** Portal open-year picker — the Dynamiq-2024 amendment case. */
import { describe, it, expect } from 'vitest'
import { pickOpenYear, mergeReachableYears } from '@/lib/portal/open-year'

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

describe('mergeReachableYears', () => {
  it('neither list has anything → empty (page still redirects, unchanged)', () => {
    expect(mergeReachableYears([], [])).toEqual([])
  })
  it('only open years, no pending review → passes through unaffected', () => {
    expect(mergeReachableYears([2025], [])).toEqual([2025])
  })
  it('only a pending-review year, intake already closed (the Adact case) → reachable on its own', () => {
    expect(mergeReachableYears([], [2025])).toEqual([2025])
  })
  it('one of each, different years → both reachable, newest first', () => {
    expect(mergeReachableYears([2026], [2025])).toEqual([2026, 2025])
  })
  it('the same year in both lists → counted once', () => {
    expect(mergeReachableYears([2025], [2025])).toEqual([2025])
  })
  it('sorts newest-first regardless of input order', () => {
    expect(mergeReachableYears([2023], [2025, 2024])).toEqual([2025, 2024, 2023])
  })
})
