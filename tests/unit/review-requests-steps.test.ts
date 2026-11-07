import { describe, it, expect } from 'vitest'
import { getWizardConfig } from '@/components/portal/wizard/wizard-configs'
import { stepIndexForKey } from '@/lib/portal/wizard-money'

// The client's "Our team asked for changes" list jumps to the step that holds each flagged answer. That jump is
// stepIndexForKey(steps, fields, key) on the form the client really gets for their company type — these pin it for the
// kinds of key a review request carries (a plain field, a row of the bank-accounts list, a tax question).
const smllc = getWizardConfig('tax', 'SMLLC')
const mmllc = getWizardConfig('tax', 'MMLLC')
const at = (cfg: typeof smllc, key: string) => stepIndexForKey(cfg.steps, cfg.fields, key)

describe('a flagged answer can be found on the form the client gets', () => {
  it('single-member form: finds a plain field', () => {
    expect(at(smllc, 'formation_costs')).toBeGreaterThanOrEqual(0)
  })

  it('multi-member form: finds a tax question and rows of the bank-accounts list (every row on the same step)', () => {
    expect(at(mmllc, 'comp_foreign_accounts_over_10k')).toBeGreaterThanOrEqual(0)
    const first = at(mmllc, 'bank_accounts_0_bank_name')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(at(mmllc, 'bank_accounts_1_statements')).toBe(first)
  })

  it('an answer the client\'s form does not ask returns -1 (the list still names it; there is just no step to jump to)', () => {
    expect(at(smllc, 'comp_foreign_accounts_over_10k')).toBe(-1)
    expect(at(smllc, 'bank_accounts_1_statements')).toBe(-1)
  })
})
