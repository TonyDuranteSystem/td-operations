import { describe, it, expect } from 'vitest'
import { csvCell, encodeMimeSubject } from '@/lib/csv-cell'

describe('csvCell', () => {
  it('leaves plain text alone', () => expect(csvCell('Acme LLC')).toBe('Acme LLC'))
  it('quotes a cell that holds a comma', () => expect(csvCell('Acme, Inc')).toBe('"Acme, Inc"'))
  it('doubles inner quotes', () => expect(csvCell('The "Best" LLC')).toBe('"The ""Best"" LLC"'))
  it('quotes line breaks', () => expect(csvCell('a\nb')).toBe('"a\nb"'))
  it('null/undefined become empty', () => { expect(csvCell(null)).toBe(''); expect(csvCell(undefined)).toBe('') })
})

describe('encodeMimeSubject (R041)', () => {
  it('encodes an em dash as RFC 2047 base64 that decodes back', () => {
    const enc = encodeMimeSubject('Tax Extension List 2025 — 12 clients')
    expect(enc).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/)
    const b64 = enc.slice('=?utf-8?B?'.length, -2)
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Tax Extension List 2025 — 12 clients')
  })
})
