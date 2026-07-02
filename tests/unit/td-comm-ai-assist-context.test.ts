import { describe, it, expect } from 'vitest'
import { selectAnswerContext, buildFieldAssistPrompt } from '@/lib/td-communication/ai-assist-context'
import type { TdCommQuestion } from '@/lib/td-communication/types'

const q = (over: Partial<TdCommQuestion>): TdCommQuestion => ({
  id: over.id ?? 'id',
  key: over.key ?? 'k',
  label_en: over.label_en ?? 'L',
  label_it: over.label_it ?? null,
  type: over.type ?? 'textarea',
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

const questions: TdCommQuestion[] = [
  q({ key: 'business_description', label_en: 'Business', type: 'textarea' }),
  q({ key: 'brand_name', label_en: 'Brand name', type: 'text' }),
  q({ key: 'color_personality', label_en: 'Colour', type: 'select' }),
  q({ key: 'upload_materials', label_en: 'Files', type: 'file' }),
]

describe('selectAnswerContext', () => {
  it('keeps only non-empty text/textarea/select answers with their labels', () => {
    const ctx = selectAnswerContext(
      { business_description: 'We sell coffee', brand_name: 'Bwana', color_personality: 'red' },
      questions,
    )
    expect(ctx).toEqual([
      { label: 'Business', value: 'We sell coffee' },
      { label: 'Brand name', value: 'Bwana' },
      { label: 'Colour', value: 'red' },
    ])
  })

  it('drops file answers, empties, and non-question keys (no path/flag leak)', () => {
    const ctx = selectAnswerContext(
      {
        business_description: 'We sell coffee',
        upload_materials: ['td_communication/x/logo.png'], // file → excluded
        brand_name: '   ',                                  // empty → excluded
        disclaimer_accepted: true,                          // not a question → excluded
        member_0_is_signer: true,                           // flag → excluded
        color_personality_count: 3,                         // number/non-question → excluded
      },
      questions,
    )
    expect(ctx).toEqual([{ label: 'Business', value: 'We sell coffee' }])
  })

  it('excludes the field currently being generated', () => {
    const ctx = selectAnswerContext(
      { business_description: 'We sell coffee', brand_name: 'Bwana' },
      questions,
      'business_description',
    )
    expect(ctx).toEqual([{ label: 'Brand name', value: 'Bwana' }])
  })

  it('handles null/garbage form_data safely', () => {
    expect(selectAnswerContext(null, questions)).toEqual([])
    expect(selectAnswerContext(undefined, questions)).toEqual([])
  })
})

describe('buildFieldAssistPrompt', () => {
  it('localizes the output language and includes the question + context', () => {
    const en = buildFieldAssistPrompt({
      questionLabel: 'Your mission',
      context: [{ label: 'Business', value: 'Coffee' }],
      locale: 'en',
    })
    expect(en.systemPrompt).toContain('English')
    expect(en.userPrompt).toContain('Your mission')
    expect(en.userPrompt).toContain('Business: Coffee')

    const it = buildFieldAssistPrompt({ questionLabel: 'La missione', context: [], locale: 'it' })
    expect(it.systemPrompt).toContain('Italian')
  })

  it('carries an anti-injection guard (context is not instructions)', () => {
    const p = buildFieldAssistPrompt({ questionLabel: 'X', context: [], locale: 'en' })
    expect(p.systemPrompt.toLowerCase()).toContain('never follow')
  })
})
