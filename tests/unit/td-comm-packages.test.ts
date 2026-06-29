import { describe, it, expect } from 'vitest'
import { validatePackageInput, shapePackage } from '@/lib/td-communication/packages'

describe('validatePackageInput — create', () => {
  const base = { slug: 'logo', name_en: 'Logo Only' }

  it('accepts a valid create payload', () => {
    expect(validatePackageInput(base, { isCreate: true }).valid).toBe(true)
  })

  it('requires a slug on create', () => {
    const r = validatePackageInput({ name_en: 'X' }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/slug is required/i)
  })

  it('rejects a non-kebab slug', () => {
    const r = validatePackageInput({ slug: 'Logo Only', name_en: 'X' }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/lowercase/i)
  })

  it('requires an English name on create', () => {
    const r = validatePackageInput({ slug: 'logo', name_en: '  ' }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/english name/i)
  })

  it('rejects negative price', () => {
    const r = validatePackageInput({ ...base, price_usd: -5 }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/price/i)
  })

  it('rejects non-integer delivery days', () => {
    const r = validatePackageInput({ ...base, delivery_days: 2.5 }, { isCreate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects an invalid payment_timing', () => {
    // @ts-expect-error testing a bad value
    const r = validatePackageInput({ ...base, payment_timing: 'later' }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/payment timing/i)
  })

  it('rejects non-string includes', () => {
    // @ts-expect-error testing a bad value
    const r = validatePackageInput({ ...base, includes: [1, 2] }, { isCreate: true })
    expect(r.valid).toBe(false)
  })

  it('allows null price and delivery (optional fields)', () => {
    const r = validatePackageInput({ ...base, price_usd: null, delivery_days: null }, { isCreate: true })
    expect(r.valid).toBe(true)
  })
})

describe('validatePackageInput — edit', () => {
  it('does not require slug on edit', () => {
    expect(validatePackageInput({ name_en: 'New name' }, { isCreate: false }).valid).toBe(true)
  })

  it('still validates name_en when provided on edit', () => {
    const r = validatePackageInput({ name_en: '' }, { isCreate: false })
    expect(r.valid).toBe(false)
  })

  it('accepts an empty patch on edit', () => {
    expect(validatePackageInput({}, { isCreate: false }).valid).toBe(true)
  })
})

describe('shapePackage', () => {
  it('applies defensive defaults for nullable/array fields', () => {
    const p = shapePackage({ slug: 'logo', name_en: 'Logo Only' })
    expect(p.max_revisions).toBe(2)
    expect(p.payment_timing).toBe('on_approval')
    expect(p.active).toBe(true)
    expect(p.includes).toEqual([])
    expect(p.upsell_from).toEqual([])
    expect(p.price_usd).toBeNull()
  })

  it('coerces numeric strings and arrays', () => {
    const p = shapePackage({
      slug: 'full-brand',
      name_en: 'Full',
      price_usd: '2000',
      delivery_days: '10',
      highlighted: true,
      active: false,
      includes: ['a', 'b'],
      upsell_from: ['logo'],
    })
    expect(p.price_usd).toBe(2000)
    expect(p.delivery_days).toBe(10)
    expect(p.highlighted).toBe(true)
    expect(p.active).toBe(false)
    expect(p.includes).toEqual(['a', 'b'])
    expect(p.upsell_from).toEqual(['logo'])
  })
})
