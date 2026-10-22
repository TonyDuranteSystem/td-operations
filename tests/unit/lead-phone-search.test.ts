import { describe, it, expect } from 'vitest'
import {
  phoneDigits,
  phoneSearchDigits,
  phoneMatches,
  findLeadIdsByPhone,
  leadSearchOrFilter,
} from '@/lib/leads/phone-search'

describe('phoneSearchDigits', () => {
  it('accepts any phone formatting', () => {
    expect(phoneSearchDigits('+39 333 000 0001')).toBe('393330000001')
    expect(phoneSearchDigits('(305) 555-1234')).toBe('3055551234')
    expect(phoneSearchDigits('3055551234')).toBe('3055551234')
  })
  it('rejects names, emails and too-short numbers', () => {
    expect(phoneSearchDigits('john')).toBeNull()
    expect(phoneSearchDigits('john 5551234')).toBeNull()
    expect(phoneSearchDigits('a@b.com')).toBeNull()
    expect(phoneSearchDigits('123')).toBeNull()
    expect(phoneSearchDigits('')).toBeNull()
  })
})

describe('phoneMatches', () => {
  it('matches across different stored formats', () => {
    expect(phoneMatches('+39-347-633-3031', '3476333031')).toBe(true)
    expect(phoneMatches('+393398755257', '339 875'.replace(/\D/g, ''))).toBe(true)
    expect(phoneMatches('+39 333 000 0001', '3330000001')).toBe(true)
  })
  it('does not match other numbers or empty phones', () => {
    expect(phoneMatches('+39 333 000 0001', '3330000002')).toBe(false)
    expect(phoneMatches(null, '3330')).toBe(false)
    expect(phoneDigits(undefined)).toBe('')
  })
})

describe('leadSearchOrFilter', () => {
  it('adds the phone ids only when there are some', () => {
    expect(leadSearchOrFilter('abc', [])).toBe('full_name.ilike.%abc%,email.ilike.%abc%')
    expect(leadSearchOrFilter('1234', ['a', 'b'])).toBe('full_name.ilike.%1234%,email.ilike.%1234%,id.in.(a,b)')
  })
})

describe('findLeadIdsByPhone', () => {
  function fakeClient(rows: { id: string; phone: string | null }[]) {
    return {
      from: () => ({
        select: () => ({
          not: () => ({
            order: () => ({
              range: (a: number, b: number) => Promise.resolve({ data: rows.slice(a, b + 1), error: null }),
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  }
  const rows = [
    { id: '1', phone: '+39 333 000 0001' },
    { id: '2', phone: '+39-347-633-3031' },
    { id: '3', phone: '+393398755257' },
  ]
  it('finds leads by digits regardless of formatting', async () => {
    expect(await findLeadIdsByPhone(fakeClient(rows), '347 633 3031')).toEqual(['2'])
    expect(await findLeadIdsByPhone(fakeClient(rows), '+393330000001')).toEqual(['1'])
  })
  it('returns nothing for non-phone text without querying', async () => {
    expect(await findLeadIdsByPhone(fakeClient(rows), 'maria')).toEqual([])
  })
  it('pages through more than 1000 leads', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: String(i), phone: i === 1400 ? '+1 305 555 9999' : '+1 000 000 0000' }))
    expect(await findLeadIdsByPhone(fakeClient(many), '3055559999')).toEqual(['1400'])
  })
})
