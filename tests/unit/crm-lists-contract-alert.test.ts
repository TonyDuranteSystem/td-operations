import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { contractAlert, personCard, PERSON_CARD_MAX_MISMATCHES } from '@/lib/crm-lists/hover-cards'
import type { ContractMismatch } from '@/lib/signed-contracts/types'
import { HoverCardBody } from '@/components/lists/hover-card'

const differs = (over: Partial<ContractMismatch> = {}): ContractMismatch => ({
  kind: 'differs',
  company: 'Xecom Consulting LLC',
  contract: 'Onboarding',
  contractAmounts: 'January $1,175 · June $1,175',
  crmAmounts: 'January $1,000 · June $1,000',
  ...over,
})
const person = { full_name: 'Gabriele Sartori', email: 'g@x.com', phone: null, language: 'Italian', portal_tier: 'active', companies: [{ company_name: 'Xecom Consulting LLC', status: 'Active' }] }

describe('contractAlert — the amber block of a person card', () => {
  it('says nothing when there is nothing to check', () => {
    expect(contractAlert(undefined)).toBeUndefined()
    expect(contractAlert([])).toBeUndefined()
  })

  it('names the company and both sets of amounts, in the words of the Contact page', () => {
    expect(contractAlert([differs()])).toEqual({
      heading: 'Contract amounts differ from the company',
      blocks: [
        {
          title: 'Xecom Consulting LLC · Onboarding contract',
          lines: ['Contract says: January $1,175 · June $1,175', 'Company in the CRM: January $1,000 · June $1,000'],
        },
      ],
    })
  })

  it('a company with no amounts says so instead of showing figures', () => {
    const a = contractAlert([differs({ kind: 'company_empty', crmAmounts: null })])!
    expect(a.heading).toBe('The company has no amounts to compare')
    expect(a.blocks[0].lines[1]).toBe('The company has no installment amounts saved in the CRM.')
  })

  it('a mix of both findings gets the plain heading', () => {
    expect(contractAlert([differs(), differs({ kind: 'company_empty', crmAmounts: null })])!.heading).toBe('Check the contract amounts')
  })

  it('cuts a long list to a few and says how many more', () => {
    const many = Array.from({ length: PERSON_CARD_MAX_MISMATCHES + 3 }, (_, i) => differs({ company: `Company ${i}` }))
    const a = contractAlert(many)!
    expect(a.blocks).toHaveLength(PERSON_CARD_MAX_MISMATCHES + 1)
    expect(a.blocks[a.blocks.length - 1]).toEqual({ title: '+ 3 more', lines: ['Open the contact to see them.'] })
  })
})

describe('personCard — the amber block only appears when there is a finding', () => {
  it('carries the alert when the person has a finding', () => {
    expect(personCard({ ...person, contract_mismatches: [differs()] }).alert?.heading).toBe('Contract amounts differ from the company')
  })

  it('has no alert key at all for a person with none (the other lists are unchanged)', () => {
    expect('alert' in personCard(person)).toBe(false)
    expect('alert' in personCard({ ...person, contract_mismatches: [] })).toBe(false)
  })
})

describe('HoverCardBody — the amber block is drawn', () => {
  it('shows the heading, the company and both figures, above the details', () => {
    const html = renderToStaticMarkup(createElement(HoverCardBody, { card: personCard({ ...person, contract_mismatches: [differs()] }) }))
    expect(html).toContain('data-testid="card-alert"')
    expect(html).toContain('amber')
    expect(html).toContain('Contract amounts differ from the company')
    expect(html).toContain('Xecom Consulting LLC · Onboarding contract')
    expect(html).toContain('Contract says: January $1,175 · June $1,175')
    expect(html).toContain('Company in the CRM: January $1,000 · June $1,000')
    expect(html.indexOf('card-alert')).toBeLessThan(html.indexOf('Email'))
  })

  it('draws no amber block for a person with no finding', () => {
    const html = renderToStaticMarkup(createElement(HoverCardBody, { card: personCard(person) }))
    expect(html).not.toContain('card-alert')
  })
})
