import { describe, it, expect } from 'vitest'
import {
  validateQuestionInput,
  questionsForAudience,
  shapeQuestion,
} from '@/lib/td-communication/questions'
import type { TdCommQuestion } from '@/lib/td-communication/types'

const q = (over: Partial<TdCommQuestion>): TdCommQuestion => ({
  id: over.id ?? 'id',
  key: over.key ?? 'k',
  label_en: over.label_en ?? 'L',
  label_it: over.label_it ?? null,
  type: over.type ?? 'text',
  required: over.required ?? false,
  step: over.step ?? 1,
  audience: over.audience ?? 'both',
  options: over.options ?? [],
  ai_assist: over.ai_assist ?? false,
  active: over.active ?? true,
  sort_order: over.sort_order ?? 0,
  created_at: '',
  updated_at: '',
})

describe('validateQuestionInput — create', () => {
  const base = { key: 'business_name', label_en: 'Business name' }

  it('accepts a valid create', () => {
    expect(validateQuestionInput(base, { isCreate: true }).valid).toBe(true)
  })

  it('requires a key', () => {
    const r = validateQuestionInput({ label_en: 'X' }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/key is required/i)
  })

  it('rejects a bad key format', () => {
    const r = validateQuestionInput({ key: 'Business Name', label_en: 'X' }, { isCreate: true })
    expect(r.valid).toBe(false)
  })

  it('allows snake and kebab keys', () => {
    expect(validateQuestionInput({ key: 'a_b-c1', label_en: 'X' }, { isCreate: true }).valid).toBe(true)
  })

  it('requires English label', () => {
    const r = validateQuestionInput({ key: 'k', label_en: '' }, { isCreate: true })
    expect(r.valid).toBe(false)
  })

  it('rejects invalid type / audience', () => {
    // @ts-expect-error bad type
    expect(validateQuestionInput({ ...base, type: 'radio' }, { isCreate: true }).valid).toBe(false)
    // @ts-expect-error bad audience
    expect(validateQuestionInput({ ...base, audience: 'old' }, { isCreate: true }).valid).toBe(false)
  })

  it('rejects step < 1', () => {
    expect(validateQuestionInput({ ...base, step: 0 }, { isCreate: true }).valid).toBe(false)
  })

  it('requires options for a select question', () => {
    const r = validateQuestionInput({ ...base, type: 'select', options: [] }, { isCreate: true })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/option/i)
  })

  it('accepts a select with legacy string options', () => {
    expect(
      validateQuestionInput({ ...base, type: 'select', options: ['a', 'b'] }, { isCreate: true }).valid,
    ).toBe(true)
  })

  it('accepts a select with object options', () => {
    expect(
      validateQuestionInput(
        { ...base, type: 'select', options: [{ value: 'red', label_en: 'Red', label_it: 'Rosso' }] },
        { isCreate: true },
      ).valid,
    ).toBe(true)
  })

  it('rejects an option with neither value nor label', () => {
    const r = validateQuestionInput(
      { ...base, type: 'select', options: [{ value: '  ', label_en: '' }] },
      { isCreate: true },
    )
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/option/i)
  })
})

describe('validateQuestionInput — edit', () => {
  it('accepts an empty patch', () => {
    expect(validateQuestionInput({}, { isCreate: false }).valid).toBe(true)
  })
})

describe('questionsForAudience', () => {
  const list = [
    q({ id: '1', key: 'a', step: 2, sort_order: 0, audience: 'both' }),
    q({ id: '2', key: 'b', step: 1, sort_order: 1, audience: 'new_brand' }),
    q({ id: '3', key: 'c', step: 1, sort_order: 0, audience: 'rebrand' }),
    q({ id: '4', key: 'd', step: 1, sort_order: 2, audience: 'both', active: false }),
  ]

  it('includes both + matching audience, excludes other audience and inactive', () => {
    const r = questionsForAudience(list, 'new_brand').map((x) => x.key)
    expect(r).toEqual(['b', 'a']) // b (step1) before a (step2); c is rebrand-only; d inactive
  })

  it('sorts by step then sort_order', () => {
    const r = questionsForAudience(list, 'rebrand').map((x) => x.key)
    expect(r).toEqual(['c', 'a'])
  })
})

describe('shapeQuestion', () => {
  it('applies defaults', () => {
    const s = shapeQuestion({ id: '1', key: 'k', label_en: 'L' })
    expect(s.type).toBe('text')
    expect(s.audience).toBe('both')
    expect(s.step).toBe(1)
    expect(s.options).toEqual([])
    expect(s.active).toBe(true)
    expect(s.ai_assist).toBe(false)
  })

  it('reads the ai_assist flag', () => {
    expect(shapeQuestion({ id: '1', key: 'k', label_en: 'L', ai_assist: true }).ai_assist).toBe(true)
    expect(shapeQuestion({ id: '1', key: 'k', label_en: 'L', ai_assist: false }).ai_assist).toBe(false)
  })

  it('coerces legacy string options to objects', () => {
    const s = shapeQuestion({ id: '1', key: 'k', label_en: 'L', options: ['Red', 'Blue'] })
    expect(s.options).toEqual([
      { value: 'Red', label_en: 'Red' },
      { value: 'Blue', label_en: 'Blue' },
    ])
  })

  it('normalizes object options (bilingual + description, null-safe)', () => {
    const s = shapeQuestion({
      id: '1', key: 'k', label_en: 'L',
      options: [{ value: 'red', label_en: 'Red', label_it: 'Rosso', description_en: 'passionate' }],
    })
    expect(s.options).toEqual([
      { value: 'red', label_en: 'Red', label_it: 'Rosso', description_en: 'passionate', description_it: null },
    ])
  })

  it('drops unusable option entries', () => {
    const s = shapeQuestion({ id: '1', key: 'k', label_en: 'L', options: ['', '  ', 42, null] })
    expect(s.options).toEqual([])
  })
})
