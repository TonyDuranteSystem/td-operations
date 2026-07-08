import { describe, it, expect } from 'vitest'
import { maxNumericSuffix } from '@/lib/portal/invoice-number'

describe('maxNumericSuffix — numeric max of PREFIX-NNNNNN numbers, malformed-safe', () => {
  it('returns the highest all-digit suffix', () => {
    expect(maxNumericSuffix(['CN-000011', 'CN-000002', 'CN-000009'], 'CN-')).toBe(11)
  })

  it('ignores malformed suffixes that LIKE "CN-______" still matches (the CN-QA0001 poison case)', () => {
    // 'CN-QA0001' lex-sorts above every numeric CN-; the old max-of-first-row
    // logic parsed NaN → always CN-000001 → permanent unique-violation loop.
    expect(maxNumericSuffix(['CN-QA0001', 'CN-000011', 'CN-000002'], 'CN-')).toBe(11)
    expect(maxNumericSuffix(['CN-0999XY', 'CN-099999'], 'CN-')).toBe(99999)
  })

  it('returns 0 when there are no valid numbers (first credit note ever)', () => {
    expect(maxNumericSuffix([], 'CN-')).toBe(0)
    expect(maxNumericSuffix(['CN-QA0001', null, 'INV-000005'], 'CN-')).toBe(0)
  })

  it('requires exactly six digits', () => {
    expect(maxNumericSuffix(['CN-12345', 'CN-1234567', 'CN-000042'], 'CN-')).toBe(42)
  })
})
