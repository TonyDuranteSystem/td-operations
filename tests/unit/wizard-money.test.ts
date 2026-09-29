/**
 * lib/portal/wizard-money.ts — the shared money-field walker used by the
 * wizard step gate/submit (client) and the wizard-submit backstop (server).
 * Dev job 89195c68.
 */
import { describe, it, expect } from 'vitest'
import type { FieldConfig } from '@/components/portal/wizard/wizard-field'
import {
  isFieldVisible,
  listMoneyKeys,
  findMoneyProblems,
  normalizeMoneyData,
  stepIndexForKey,
  moneyOptionsFor,
  moneyProblemMessage,
} from '@/lib/portal/wizard-money'
import { boxTextForValue } from '@/lib/money-input'
import { getWizardConfig, TAX_FIELDS, TAX_CORP_FIELDS } from '@/components/portal/wizard/wizard-configs'

const steps = [{ id: 'owner' }, { id: 'financials' }, { id: 'documents' }]
const fields: Record<string, FieldConfig[]> = {
  owner: [{ name: 'first_name', label: 'First', type: 'text' }],
  financials: [
    { name: 'distributions', label: 'Distributions', type: 'number', min: 0, format: 'money' },
    { name: 'loss', label: 'Loss', type: 'number', format: 'money' },
    { name: 'has_rpt', label: 'Related?', type: 'select' },
    {
      name: 'rpt', label: 'Transactions', type: 'repeater',
      conditional: { field: 'has_rpt', value: 'Yes' },
      repeaterFields: [
        { name: 'rpt_name', label: 'Name', type: 'text' },
        { name: 'rpt_amount', label: 'Amount', type: 'number', min: 0, format: 'money' },
      ],
    },
  ],
  documents: [],
}

describe('isFieldVisible', () => {
  it('follows the condition chain', () => {
    const f = fields.financials[3]
    expect(isFieldVisible(f, fields.financials, { has_rpt: 'Yes' })).toBe(true)
    expect(isFieldVisible(f, fields.financials, { has_rpt: 'No' })).toBe(false)
  })
})

describe('moneyOptionsFor', () => {
  it('min 0 refuses negatives; no min keeps accepting them', () => {
    expect(moneyOptionsFor(fields.financials[0]).allowNegative).toBe(false)
    expect(moneyOptionsFor(fields.financials[1]).allowNegative).toBe(true)
  })
})

describe('listMoneyKeys', () => {
  it('expands repeater rows up to the count and marks visibility', () => {
    const keys = listMoneyKeys(steps, fields, { has_rpt: 'No', rpt_count: 2 })
    expect(keys.map(k => [k.key, k.stepIndex, k.visible])).toEqual([
      ['distributions', 1, true],
      ['loss', 1, true],
      ['rpt_0_rpt_amount', 1, false],
      ['rpt_1_rpt_amount', 1, false],
    ])
  })
  it('no rows without a count', () => {
    expect(listMoneyKeys(steps, fields, { has_rpt: 'Yes' }).map(k => k.key)).toEqual(['distributions', 'loss'])
  })
})

describe('findMoneyProblems', () => {
  it('flags pending, unreadable, decimals and negatives on visible keys only', () => {
    const data = {
      distributions: '80.000',
      loss: -50,
      has_rpt: 'Yes',
      rpt_count: 3,
      rpt_0_rpt_amount: 'abc',
      rpt_1_rpt_amount: 10.596,
      rpt_2_rpt_amount: -1,
    }
    expect(findMoneyProblems(steps, fields, data)).toEqual([
      { key: 'distributions', stepIndex: 1, problem: 'unanswered', detail: 'ambiguous' },
      { key: 'rpt_0_rpt_amount', stepIndex: 1, problem: 'unanswered', detail: 'unreadable' },
      { key: 'rpt_1_rpt_amount', stepIndex: 1, problem: 'too_many_decimals', detail: undefined },
      { key: 'rpt_2_rpt_amount', stepIndex: 1, problem: 'negative', detail: undefined },
    ])
  })
  it('a hidden field never blocks', () => {
    const data = { has_rpt: 'No', rpt_count: 1, rpt_0_rpt_amount: '80.000' }
    expect(findMoneyProblems(steps, fields, data)).toEqual([])
  })
  it('settled numbers and empties pass', () => {
    expect(findMoneyProblems(steps, fields, { distributions: 80000, loss: '' })).toEqual([])
  })
})

describe('normalizeMoneyData', () => {
  it('turns clean strings into numbers, keeps pending strings on visible fields', () => {
    const data = { distributions: '5000', loss: '80.000', first_name: '80.000' }
    expect(normalizeMoneyData(steps, fields, data, { clearHiddenPending: true })).toEqual({
      distributions: 5000, loss: '80.000', first_name: '80.000',
    })
  })
  it('clears a pending string on a hidden field, only when asked', () => {
    const data = { has_rpt: 'No', rpt_count: 1, rpt_0_rpt_amount: '80.000', rpt_0_rpt_name: 'X' }
    expect(normalizeMoneyData(steps, fields, data, { clearHiddenPending: true }).rpt_0_rpt_amount).toBe('')
    expect(normalizeMoneyData(steps, fields, data, { clearHiddenPending: false }).rpt_0_rpt_amount).toBe('80.000')
  })
  it('does not add keys that were absent, does not mutate input', () => {
    const data = { first_name: 'A' }
    const out = normalizeMoneyData(steps, fields, data, { clearHiddenPending: true })
    expect(out).toEqual({ first_name: 'A' })
    expect(out).not.toBe(data)
  })
})

describe('stepIndexForKey', () => {
  it('finds top-level and repeater keys', () => {
    expect(stepIndexForKey(steps, fields, 'first_name')).toBe(0)
    expect(stepIndexForKey(steps, fields, 'loss')).toBe(1)
    expect(stepIndexForKey(steps, fields, 'rpt_4_rpt_amount')).toBe(1)
    expect(stepIndexForKey(steps, fields, 'rpt_4_nope')).toBe(-1)
    expect(stepIndexForKey(steps, fields, 'unknown')).toBe(-1)
  })
})

describe('moneyProblemMessage', () => {
  it('is bilingual and names the stored value for decimals', () => {
    expect(moneyProblemMessage({ problem: 'too_many_decimals' }, 10.596).en).toContain('10.596')
    expect(moneyProblemMessage({ problem: 'unanswered', detail: 'ambiguous' }).it).toContain('Quale importo')
    expect(moneyProblemMessage({ problem: 'negative' }).en).toBe('This amount cannot be negative.')
  })
})

describe('boxTextForValue', () => {
  it('numbers in US format, legacy decimals kept, strings verbatim', () => {
    expect(boxTextForValue(80000)).toBe('80,000')
    expect(boxTextForValue(80.5)).toBe('80.50')
    expect(boxTextForValue(10.596)).toBe('10.596')
    expect(boxTextForValue('80.000')).toBe('80.000')
    expect(boxTextForValue('')).toBe('')
    expect(boxTextForValue(undefined)).toBe('')
  })
})

describe('real tax configs', () => {
  it('SMLLC tax money fields are all format money', () => {
    const names = TAX_FIELDS.financials.filter(f => f.format === 'money').map(f => f.name)
    expect(names).toEqual(['formation_costs', 'bank_contributions', 'distributions_withdrawals', 'personal_expenses'])
    const rpt = TAX_FIELDS.financials.find(f => f.name === 'related_party_transactions')
    expect(rpt?.repeaterFields?.find(rf => rf.name === 'rpt_amount')?.format).toBe('money')
  })
  it('Corp money fields accept negatives (no min), as before', () => {
    const corp = TAX_CORP_FIELDS.financials.filter(f => f.format === 'money')
    expect(corp.map(f => f.name)).toEqual([
      'corp_contributions', 'corp_distributions', 'corp_dividends_paid', 'corp_estimated_taxes_paid', 'corp_rental_passive_income',
    ])
    expect(corp.every(f => moneyOptionsFor(f).allowNegative)).toBe(true)
  })
  it('the walker finds the related-party amount only when visible', () => {
    const { steps: s, fields: f } = getWizardConfig('tax', 'SMLLC')
    const base = { related_party_transactions_count: 1, related_party_transactions_0_rpt_amount: '80.000' }
    const hidden = findMoneyProblems(s, f, { ...base, has_related_party_transactions: 'No' })
    const shown = findMoneyProblems(s, f, { ...base, has_related_party_transactions: 'Yes' })
    expect(hidden.map(p => p.key)).not.toContain('related_party_transactions_0_rpt_amount')
    expect(shown.map(p => p.key)).toContain('related_party_transactions_0_rpt_amount')
  })
  it('no non-tax wizard uses the money format yet (scope guard)', () => {
    for (const t of ['formation', 'onboarding', 'banking_payset', 'banking_relay', 'closure', 'itin', 'company_info']) {
      const { steps: s, fields: f } = getWizardConfig(t)
      expect(listMoneyKeys(s, f, {})).toEqual([])
    }
  })
})
