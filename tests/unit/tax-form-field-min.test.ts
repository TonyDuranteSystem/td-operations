import { describe, it, expect } from 'vitest'
import { fieldMin, violatesFieldMin, FORM_FIELDS } from '@/lib/types/tax-form'

// Guard against the Rocco Papotti incident (2026-07-15): the tax form's
// currency inputs accepted negative values (-0.03 / -0.04 via spinner or
// scroll-wheel decrements from 0), which flowed verbatim into the accountant
// summary PDF. Currency fields can never be negative on these forms.
describe('fieldMin', () => {
  it('defaults currency fields to a minimum of 0', () => {
    expect(fieldMin({ type: 'currency' })).toBe(0)
  })

  it('leaves non-currency fields unbounded by default', () => {
    expect(fieldMin({ type: 'number' })).toBeUndefined()
    expect(fieldMin({ type: 'text' })).toBeUndefined()
  })

  it('lets an explicit min override the type default', () => {
    expect(fieldMin({ type: 'currency', min: 100 })).toBe(100)
    expect(fieldMin({ type: 'number', min: 0 })).toBe(0)
  })
})

describe('violatesFieldMin', () => {
  const currency = { type: 'currency' }

  it('flags negative currency values (the -0.03 incident shape)', () => {
    expect(violatesFieldMin(currency, -0.03)).toBe(true)
    expect(violatesFieldMin(currency, -0.04)).toBe(true)
    expect(violatesFieldMin(currency, '-0.03')).toBe(true)
    expect(violatesFieldMin(currency, -1)).toBe(true)
  })

  it('accepts zero and positive currency values', () => {
    expect(violatesFieldMin(currency, 0)).toBe(false)
    expect(violatesFieldMin(currency, '0')).toBe(false)
    expect(violatesFieldMin(currency, 34659.79)).toBe(false)
  })

  it('never flags empty/absent values — presence is the required check', () => {
    expect(violatesFieldMin(currency, '')).toBe(false)
    expect(violatesFieldMin(currency, null)).toBe(false)
    expect(violatesFieldMin(currency, undefined)).toBe(false)
  })

  it('ignores non-numeric garbage instead of blocking on NaN', () => {
    expect(violatesFieldMin(currency, 'abc')).toBe(false)
  })

  it('does nothing for fields without an effective minimum', () => {
    expect(violatesFieldMin({ type: 'number' }, -5)).toBe(false)
  })

  it('respects an explicit min on non-currency fields', () => {
    expect(violatesFieldMin({ type: 'number', min: 0 }, -1)).toBe(true)
    expect(violatesFieldMin({ type: 'number', min: 0 }, 1)).toBe(false)
  })
})

describe('tax form field definitions', () => {
  it('every SMLLC money field is a currency field (min 0 by type)', () => {
    for (const key of ['formation_costs', 'bank_contributions', 'distributions_withdrawals', 'personal_expenses']) {
      const field = FORM_FIELDS.find(f => f.key === key)
      expect(field, key).toBeDefined()
      expect(field!.type, key).toBe('currency')
      expect(fieldMin(field!), key).toBe(0)
    }
  })

  it('every currency field in the catalog has an effective min of 0 or higher', () => {
    const collect = (fields: { type: string; min?: number; arrayFields?: unknown }[]): void => {
      for (const f of fields) {
        if (f.type === 'currency') expect(fieldMin(f)! >= 0).toBe(true)
        if (Array.isArray((f as { arrayFields?: unknown[] }).arrayFields)) {
          collect((f as { arrayFields: { type: string; min?: number }[] }).arrayFields)
        }
      }
    }
    collect(FORM_FIELDS)
  })
})
