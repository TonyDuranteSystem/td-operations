import { describe, it, expect } from 'vitest'
import { buildTdCommWizardConfig } from '@/lib/td-communication/question-to-field'
import type { TdCommQuestion, TdCommOption } from '@/lib/td-communication/types'

const q = (over: Partial<TdCommQuestion>): TdCommQuestion => ({
  id: over.id ?? 'id',
  key: over.key ?? 'k',
  label_en: over.label_en ?? 'L',
  label_it: over.label_it ?? null,
  type: over.type ?? 'textarea',
  required: over.required ?? true,
  step: over.step ?? 1,
  audience: over.audience ?? 'both',
  options: over.options ?? [],
  active: over.active ?? true,
  sort_order: over.sort_order ?? 0,
  created_at: '',
  updated_at: '',
})

describe('buildTdCommWizardConfig', () => {
  it('returns an empty config when there are no applicable questions', () => {
    expect(buildTdCommWizardConfig([], 'new_brand')).toEqual({ steps: [], fields: {} })
  })

  it('groups questions by step into step_<n> ids with bilingual titles', () => {
    const cfg = buildTdCommWizardConfig(
      [
        q({ key: 'a', step: 1, sort_order: 1 }),
        q({ key: 'business_description', step: 1, sort_order: 0 }),
        q({ key: 'brand_name', step: 3, type: 'text' }),
      ],
      'new_brand',
    )
    expect(cfg.steps.map((s) => s.id)).toEqual(['step_1', 'step_3'])
    expect(cfg.steps[0]).toMatchObject({ title: 'Business & Strategy', titleIt: 'Business e Strategia' })
    expect(cfg.steps[1]).toMatchObject({ title: 'Visual & Design', titleIt: 'Visual e Design' })
    // sort_order preserved within a step
    expect(cfg.fields.step_1.map((f) => f.name)).toEqual(['business_description', 'a'])
  })

  it('falls back to a generic bilingual title for an unmapped step number', () => {
    const cfg = buildTdCommWizardConfig([q({ key: 'x', step: 7 })], 'new_brand')
    expect(cfg.steps[0]).toMatchObject({ id: 'step_7', title: 'Step 7', titleIt: 'Passo 7' })
  })

  it('maps a question to a FieldConfig and preserves label_it', () => {
    const cfg = buildTdCommWizardConfig(
      [q({ key: 'mission', label_en: 'Your mission', label_it: 'La tua missione', required: false })],
      'new_brand',
    )
    const f = cfg.fields.step_1[0]
    expect(f).toMatchObject({ name: 'mission', label: 'Your mission', labelIt: 'La tua missione', type: 'textarea', required: false })
  })

  it('folds option descriptions into the bilingual label', () => {
    const opts: TdCommOption[] = [
      { value: 'blue', label_en: 'Blue', label_it: 'Blu', description_en: 'calm', description_it: 'calmo' },
      { value: 'red', label_en: 'Red', label_it: null, description_en: null, description_it: null },
    ]
    const cfg = buildTdCommWizardConfig([q({ key: 'color', step: 3, type: 'select', options: opts })], 'new_brand')
    const field = cfg.fields.step_3[0]
    expect(field.options).toEqual([
      { value: 'blue', label: 'Blue — calm', labelIt: 'Blu — calmo' },
      { value: 'red', label: 'Red' }, // no IT label → no labelIt; no description → not folded
    ])
  })

  it('attaches the ✨ aiAssist helper only to business_description', () => {
    const cfg = buildTdCommWizardConfig(
      [q({ key: 'business_description', step: 1 }), q({ key: 'added_value', step: 1, sort_order: 1 })],
      'new_brand',
    )
    const [desc, other] = cfg.fields.step_1
    expect(desc.aiAssist).toBe(true)
    expect(other.aiAssist).toBeUndefined()
  })

  it('appends the disclaimer checkbox to the LAST step only', () => {
    const cfg = buildTdCommWizardConfig(
      [q({ key: 'a', step: 1 }), q({ key: 'b', step: 2 })],
      'new_brand',
    )
    // step_1 untouched
    expect(cfg.fields.step_1.some((f) => f.name === 'disclaimer_accepted')).toBe(false)
    // step_2 (last) gets the checkbox at the end
    const last = cfg.fields.step_2
    expect(last[last.length - 1]).toMatchObject({ name: 'disclaimer_accepted', type: 'checkbox', required: true })
  })

  it('respects the audience filter (excludes other-audience + inactive)', () => {
    const cfg = buildTdCommWizardConfig(
      [
        q({ key: 'keep', step: 1, audience: 'both' }),
        q({ key: 'rebrand_only', step: 1, sort_order: 1, audience: 'rebrand' }),
        q({ key: 'off', step: 1, sort_order: 2, audience: 'both', active: false }),
      ],
      'new_brand',
    )
    const names = cfg.fields.step_1.map((f) => f.name).filter((n) => n !== 'disclaimer_accepted')
    expect(names).toEqual(['keep'])
  })
})
