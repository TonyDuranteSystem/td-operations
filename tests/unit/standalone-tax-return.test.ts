import { describe, it, expect } from 'vitest'
import { isStandaloneTaxReturnPipelines, standaloneTaxReturnStart, STANDALONE_TR_STAGES } from '@/lib/tax/standalone-tax-return'

describe('isStandaloneTaxReturnPipelines', () => {
  it('is true when the Tax Return is the only service', () => {
    expect(isStandaloneTaxReturnPipelines(['Tax Return'])).toBe(true)
  })
  it('counts a repeated Tax Return entry as one', () => {
    expect(isStandaloneTaxReturnPipelines(['Tax Return', 'Tax Return'])).toBe(true)
    expect(isStandaloneTaxReturnPipelines([' Tax Return '])).toBe(true)
  })
  it('is false when anything else is sold with it', () => {
    expect(isStandaloneTaxReturnPipelines(['Tax Return', 'EIN'])).toBe(false)
    expect(isStandaloneTaxReturnPipelines(['Company Closure', 'Tax Return'])).toBe(false)
    expect(isStandaloneTaxReturnPipelines(['CMRA Mailing Address', 'State RA Renewal', 'State Annual Report', 'Tax Return'])).toBe(false)
  })
  it('is false for no services, another single service, or not a list', () => {
    expect(isStandaloneTaxReturnPipelines([])).toBe(false)
    expect(isStandaloneTaxReturnPipelines(['EIN'])).toBe(false)
    expect(isStandaloneTaxReturnPipelines(null)).toBe(false)
    expect(isStandaloneTaxReturnPipelines(undefined)).toBe(false)
    expect(isStandaloneTaxReturnPipelines('Tax Return')).toBe(false)
    expect(isStandaloneTaxReturnPipelines([null, 3, ''])).toBe(false)
  })
})

describe('standaloneTaxReturnStart', () => {
  it('starts at Company Data Pending when there is no company yet', () => {
    expect(standaloneTaxReturnStart({ standalone: true, companyReturn: true, hasCompany: false })).toEqual({
      createAt: STANDALONE_TR_STAGES.companyDataPending,
      openAt: null,
    })
  })
  it('is created at Paid - Awaiting Data and opens at Wizard Available when the company is known', () => {
    expect(standaloneTaxReturnStart({ standalone: true, companyReturn: true, hasCompany: true })).toEqual({
      createAt: STANDALONE_TR_STAGES.paidAwaitingData,
      openAt: STANDALONE_TR_STAGES.open,
    })
  })
  it('leaves everything else on the existing path', () => {
    expect(standaloneTaxReturnStart({ standalone: false, companyReturn: true, hasCompany: true })).toBeNull()
    expect(standaloneTaxReturnStart({ standalone: true, companyReturn: false, hasCompany: true })).toBeNull()
    expect(standaloneTaxReturnStart({ standalone: false, companyReturn: false, hasCompany: false })).toBeNull()
  })
})
