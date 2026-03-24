import { describe, it, expect } from 'vitest'
import {
  stringSimilarity,
  normalizeCompanyName,
  normalizeEIN,
} from '../../lib/jobs/ocr-crosscheck'

describe('stringSimilarity', () => {
  it('returns 100 for identical strings', () => {
    expect(stringSimilarity('hello', 'hello')).toBe(100)
  })

  it('is case-insensitive', () => {
    expect(stringSimilarity('Hello', 'hello')).toBe(100)
  })

  it('returns 0 for empty inputs', () => {
    expect(stringSimilarity('', 'hello')).toBe(0)
    expect(stringSimilarity('hello', '')).toBe(0)
  })

  it('handles similar strings with high score', () => {
    const sim = stringSimilarity('My Company LLC', 'MY COMPANY LLC')
    expect(sim).toBe(100)
  })

  it('handles minor typos with reasonable score', () => {
    const sim = stringSimilarity('Acme Holdings', 'Acme Holdnigs')
    expect(sim).toBeGreaterThan(80)
  })

  it('handles completely different strings with low score', () => {
    const sim = stringSimilarity('Apple Inc', 'Banana Corp')
    expect(sim).toBeLessThan(50)
  })
})

describe('normalizeCompanyName', () => {
  it('strips LLC suffix', () => {
    expect(normalizeCompanyName('My Company LLC')).toBe('my company')
    expect(normalizeCompanyName('My Company, LLC')).toBe('my company')
    expect(normalizeCompanyName('My Company L.L.C.')).toBe('my company')
  })

  it('strips punctuation', () => {
    expect(normalizeCompanyName("O'Brien & Co.")).toBe('obrien co')
  })

  it('normalizes whitespace', () => {
    expect(normalizeCompanyName('  My   Company  ')).toBe('my company')
  })
})

describe('normalizeEIN', () => {
  it('strips formatting', () => {
    expect(normalizeEIN('30-1482516')).toBe('301482516')
    expect(normalizeEIN('30 1482516')).toBe('301482516')
    expect(normalizeEIN('30.1482516')).toBe('301482516')
  })

  it('handles clean input', () => {
    expect(normalizeEIN('301482516')).toBe('301482516')
  })
})
