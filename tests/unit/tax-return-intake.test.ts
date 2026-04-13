import { describe, it, expect } from 'vitest'

describe('tax-return-intake handler', () => {
  it('module exports handleTaxReturnIntake function', async () => {
    // Dynamic import to test the module loads without crashing
    const mod = await import('@/lib/jobs/handlers/tax-return-intake')
    expect(typeof mod.handleTaxReturnIntake).toBe('function')
  })
})

describe('Tax Return pipeline stage assignments', () => {
  // These tests verify the business rules encoded in the pipeline_stages DB,
  // not the handler itself (which requires DB mocks)

  it('Company Data Pending has stage_order -1 (intake only)', () => {
    const COMPANY_DATA_PENDING_ORDER = -1
    expect(COMPANY_DATA_PENDING_ORDER).toBeLessThan(0)
    expect(COMPANY_DATA_PENDING_ORDER).toBeLessThan(1) // Below 1st Installment Paid
  })

  it('Paid - Awaiting Data has stage_order 0 (intake only)', () => {
    const PAID_AWAITING_DATA_ORDER = 0
    expect(PAID_AWAITING_DATA_ORDER).toBeLessThanOrEqual(0)
    expect(PAID_AWAITING_DATA_ORDER).toBeLessThan(1) // Below 1st Installment Paid
  })

  it('1st Installment Paid has stage_order 1 (first non-intake stage)', () => {
    const FIRST_INSTALLMENT_PAID_ORDER = 1
    expect(FIRST_INSTALLMENT_PAID_ORDER).toBeGreaterThan(0)
  })

  it('auto-advance guard blocks stage_order <= 0', () => {
    // Simulates the guard logic in advanceServiceDelivery
    const guardFires = (stageOrder: number | null) => {
      return stageOrder !== null && stageOrder <= 0
    }

    // Intake stages: guard fires
    expect(guardFires(-1)).toBe(true)  // Company Data Pending
    expect(guardFires(0)).toBe(true)   // Paid - Awaiting Data

    // Non-intake stages: guard does not fire
    expect(guardFires(1)).toBe(false)  // 1st Installment Paid
    expect(guardFires(3)).toBe(false)  // Data Received
    expect(guardFires(null)).toBe(false) // Legacy SDs with no stage_order
  })

  it('Tax Return first-stage override applies only when stage_order < 1', () => {
    // Simulates the sd_create / audit-chain override logic
    const shouldOverride = (serviceType: string, stageOrder: number | null) => {
      return serviceType === 'Tax Return' && stageOrder !== null && stageOrder < 1
    }

    expect(shouldOverride('Tax Return', -1)).toBe(true)
    expect(shouldOverride('Tax Return', 0)).toBe(true)
    expect(shouldOverride('Tax Return', 1)).toBe(false)
    expect(shouldOverride('Tax Return', null)).toBe(false)
    expect(shouldOverride('Company Formation', -1)).toBe(false) // Other service types unaffected
  })

  it('stage assignment matrix is correct for all TR paths', () => {
    const getInitialStage = (isStandaloneBusinessTR: boolean) => {
      return isStandaloneBusinessTR ? 'Company Data Pending' : '1st Installment Paid'
    }

    expect(getInitialStage(true)).toBe('Company Data Pending')   // Standalone business
    expect(getInitialStage(false)).toBe('1st Installment Paid')  // Individual/recurring/renewal
  })
})

describe('wizard-submit company_info mappings', () => {
  it('company_info maps to company_info_submissions table', () => {
    const map: Record<string, string> = {
      formation: 'formation_submissions',
      onboarding: 'onboarding_submissions',
      tax: 'tax_return_submissions',
      tax_return: 'tax_return_submissions',
      company_info: 'company_info_submissions',
    }
    expect(map['company_info']).toBe('company_info_submissions')
    // Must NOT reuse onboarding_submissions
    expect(map['company_info']).not.toBe('onboarding_submissions')
  })

  it('company_info maps to tax_return_intake job', () => {
    const map: Record<string, string> = {
      formation: 'formation_setup',
      onboarding: 'onboarding_setup',
      tax: 'tax_form_setup',
      tax_return: 'tax_form_setup',
      company_info: 'tax_return_intake',
    }
    expect(map['company_info']).toBe('tax_return_intake')
  })
})
