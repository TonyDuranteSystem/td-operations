import { describe, it, expect } from 'vitest'
import { parseOwner, parseFollowUpDate, addDaysYmd, LEAD_OWNERS } from '@/lib/leads/owners'

describe('parseOwner', () => {
  it('accepts a listed owner and clears with null or empty', () => {
    for (const o of LEAD_OWNERS) expect(parseOwner(o)).toEqual({ ok: true, value: o, message: '' })
    expect(parseOwner(null).value).toBeNull()
    expect(parseOwner('').ok).toBe(true)
  })
  it('rejects anyone else, including odd types', () => {
    for (const bad of ['luca', 'Marco', 'Luca ', 5, {}, undefined]) expect(parseOwner(bad).ok).toBe(false)
    expect(parseOwner('Marco').message).toMatch(/Antonio, Luca, Rocco, Ale/)
  })
})

describe('parseFollowUpDate', () => {
  it('accepts a real date and clears with null', () => {
    expect(parseFollowUpDate('2026-11-04')).toEqual({ ok: true, value: '2026-11-04', message: '' })
    expect(parseFollowUpDate(null).value).toBeNull()
    expect(parseFollowUpDate('2028-02-29').ok).toBe(true)
  })
  it('rejects wrong formats and dates that do not exist', () => {
    for (const bad of ['4 Nov 2026', '2026-13-01', '2026-02-30', '2027-02-29', '2026-1-4', 20261104, undefined]) expect(parseFollowUpDate(bad).ok).toBe(false)
  })
})

describe('addDaysYmd', () => {
  it('adds days across month and year ends', () => {
    expect(addDaysYmd('2026-11-01', 3)).toBe('2026-11-04')
    expect(addDaysYmd('2026-12-30', 5)).toBe('2027-01-04')
    expect(addDaysYmd('2026-11-04', -4)).toBe('2026-10-31')
  })
})
