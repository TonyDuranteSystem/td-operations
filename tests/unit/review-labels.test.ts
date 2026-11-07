import { describe, it, expect } from 'vitest'
import { TAX_FIELDS, TAX_MEMBER_FIELDS } from '@/components/portal/wizard/wizard-configs'
import { resolveClientLabel } from '@/lib/tax/review-labels'

const all = Object.values(TAX_FIELDS).flat()

describe('resolveClientLabel — an answer in the client\'s own words', () => {
  it('uses the questionnaire label in each language for a plain field', () => {
    const f = all.find((x) => x.labelIt && !x.repeaterFields)!
    expect(resolveClientLabel(f.name, 'en')).toBe(f.label)
    expect(resolveClientLabel(f.name, 'it')).toBe(f.labelIt)
  })

  it('falls back to English when the field has no Italian label', () => {
    const f = all.find((x) => !x.labelIt && !x.repeaterFields)
    if (f) expect(resolveClientLabel(f.name, 'it')).toBe(f.label)
  })

  it('names a member\'s field with the member\'s number (one-based)', () => {
    const f = TAX_MEMBER_FIELDS.find((x) => x.labelIt)!
    expect(resolveClientLabel(`member_1_${f.name}`, 'en')).toBe(`${f.label} (Member 2)`)
    expect(resolveClientLabel(`member_0_${f.name}`, 'it')).toBe(`${f.labelIt} (Membro 1)`)
  })

  it('names a row of a repeating list with the row\'s number (one-based)', () => {
    const list = all.find((x) => x.type === 'repeater' && x.repeaterFields?.some((r) => r.labelIt))!
    const sub = list.repeaterFields!.find((r) => r.labelIt)!
    const en = resolveClientLabel(`${list.name}_1_${sub.name}`, 'en')
    expect(en.startsWith(`${sub.label} (`)).toBe(true)
    expect(en.endsWith(' 2)')).toBe(true)
    expect(resolveClientLabel(`${list.name}_0_${sub.name}`, 'it').startsWith(`${sub.labelIt} (`)).toBe(true)
  })

  it('an answer the questionnaire does not know reads as the review screen\'s English label', () => {
    expect(resolveClientLabel('zzz_unknown_answer', 'it')).toBe('Zzz Unknown Answer')
    expect(resolveClientLabel('widgets_2_colour', 'en')).toBe('Colour (Widget 3)')
  })
})
