import { describe, it, expect, vi } from 'vitest'
import {
  phoneDigits,
  phoneSearchDigits,
  phoneMatches,
  findLeadIdsByPhone,
  leadSearchOrFilter,
  quoteFilterValue,
  MAX_PHONE_IDS,
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
  it('quotes the typed text and adds the phone ids only when there are some', () => {
    expect(leadSearchOrFilter('abc', [])).toBe('full_name.ilike."%abc%",email.ilike."%abc%"')
    expect(leadSearchOrFilter('1234', ['a', 'b'])).toBe('full_name.ilike."%1234%",email.ilike."%1234%",id.in.(a,b)')
  })
  it('keeps brackets and commas inside the quoted value so they cannot break the filter', () => {
    expect(leadSearchOrFilter('(347) 633-3031', ['x'])).toBe(
      'full_name.ilike."%(347) 633-3031%",email.ilike."%(347) 633-3031%",id.in.(x)',
    )
    expect(leadSearchOrFilter('Smith, John', [])).toBe('full_name.ilike."%Smith, John%",email.ilike."%Smith, John%"')
  })
})

describe('quoteFilterValue', () => {
  it('escapes quotes and backslashes', () => {
    expect(quoteFilterValue('a"b')).toBe('"a\\"b"')
    expect(quoteFilterValue('a\\b')).toBe('"a\\\\b"')
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
  it('caps the list so a broad number cannot build an oversized request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const many = Array.from({ length: 500 }, (_, i) => ({ id: String(i), phone: '+39 333 000 0001' }))
    const ids = await findLeadIdsByPhone(fakeClient(many), '39333')
    expect(ids).toHaveLength(MAX_PHONE_IDS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('does not throw when the lookup fails — returns empty so name/email search still runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = {
      from: () => ({
        select: () => ({
          not: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    expect(await findLeadIdsByPhone(failing, '3476333031')).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
  it('does not throw when the client itself throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exploding = { from: () => { throw new Error('network') } } as any
    expect(await findLeadIdsByPhone(exploding, '3476333031')).toEqual([])
    err.mockRestore()
  })
})
