import { describe, it, expect } from 'vitest'
import {
  classifyAccount,
  STANDARD_CLIENT_SDS,
  TAX_RETURN_SD,
  type ClassificationInput,
} from '@/lib/account-classification'

// ── Helper: build a base input with defaults ──

function base(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    accountId: 'test-id',
    accountType: 'Client',
    accountStatus: 'Active',
    einNumber: null,
    formationDate: null,
    entityType: 'Single Member LLC',
    activeServiceTypes: [],
    formationSD: null,
    taxReturn: null,
    ss4: null,
    currentYear: 2026,
    ...overrides,
  }
}

// ═══════════════════════════════════════
// CATEGORY CLASSIFICATION
// ═══════════════════════════════════════

describe('classifyAccount — category', () => {
  it('active_client: has EIN, formation done, has formation SD (completed)', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2025-06-15',
      formationSD: { stage: 'Completed', stageOrder: 6, status: 'completed' },
      activeServiceTypes: ['State RA Renewal', 'Tax Return'],
    }))
    expect(r.category).toBe('active_client')
    expect(r.formationComplete).toBe(true)
    expect(r.isWaitingForEIN).toBe(false)
  })

  it('legacy_client: has EIN, formation done, but no formation SD in system', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2025-06-15',
      activeServiceTypes: ['State RA Renewal', 'Tax Return'],
    }))
    expect(r.category).toBe('legacy_client')
    expect(r.formationComplete).toBe(true)
  })

  it('one_time: One-Time account type', () => {
    const r = classifyAccount(base({
      accountType: 'One-Time',
      einNumber: '12-3456789',
      activeServiceTypes: ['Tax Return'],
    }))
    expect(r.category).toBe('one_time')
  })

  it('new_formation: formation SD active, not yet formed', () => {
    const r = classifyAccount(base({
      formationSD: { stage: 'State Filing', stageOrder: 2, status: 'active' },
    }))
    expect(r.category).toBe('new_formation')
    expect(r.formationInProgress).toBe(true)
    expect(r.formationComplete).toBe(false)
  })

  it('pending_ein: formed this year, EIN missing, SS-4 submitted', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-15',
      formationSD: { stage: 'EIN Submitted', stageOrder: 4, status: 'active' },
      ss4: { status: 'submitted' },
    }))
    expect(r.category).toBe('pending_ein')
    expect(r.isWaitingForEIN).toBe(true)
    expect(r.formationComplete).toBe(false)
    expect(r.pendingReasons.some(p => p.field === 'ein_number')).toBe(true)
  })

  it('pending_ein: formed this year, EIN missing, formation at EIN Application stage', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-20',
      formationSD: { stage: 'EIN Application', stageOrder: 3, status: 'active' },
    }))
    expect(r.category).toBe('pending_ein')
    expect(r.isWaitingForEIN).toBe(true)
  })

  it('legacy_client: EIN exists, no formation SD, old formation date', () => {
    const r = classifyAccount(base({
      einNumber: '99-1234567',
      formationDate: '2023-01-15',
      activeServiceTypes: ['State RA Renewal', 'CMRA Mailing Address'],
    }))
    expect(r.category).toBe('legacy_client')
    expect(r.formationComplete).toBe(true)
  })

  it('legacy_client: tax return exists but no EIN and no formation SD (Stepwell-like)', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-13',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
      activeServiceTypes: ['Annual Renewal', 'CMRA Mailing Address', 'State RA Renewal', 'State Annual Report'],
    }))
    // taxReturn exists → formationComplete = true
    // no formationSD + taxReturn present → legacy_client
    expect(r.formationComplete).toBe(true)
    expect(r.category).toBe('legacy_client')
  })

  it('incomplete: Client account with no formation data at all', () => {
    const r = classifyAccount(base({
      // no EIN, no formationDate, no formationSD, no taxReturn
    }))
    expect(r.category).toBe('incomplete')
    expect(r.formationComplete).toBe(false)
  })

  it('active_client: formation SD active BUT EIN already received (finishing up)', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2026-02-10',
      formationSD: { stage: 'Post-Formation + Banking', stageOrder: 5, status: 'active' },
    }))
    expect(r.category).toBe('active_client')
    expect(r.formationComplete).toBe(true)
    expect(r.formationInProgress).toBe(true)
  })
})

// ═══════════════════════════════════════
// FORMATION COMPLETENESS SIGNALS
// ═══════════════════════════════════════

describe('classifyAccount — formation signals', () => {
  it('formationComplete from EIN', () => {
    const r = classifyAccount(base({ einNumber: '12-3456789' }))
    expect(r.formationComplete).toBe(true)
  })

  it('formationComplete from completed formation SD', () => {
    const r = classifyAccount(base({
      formationSD: { stage: 'Completed', stageOrder: 6, status: 'completed' },
    }))
    expect(r.formationComplete).toBe(true)
  })

  it('formationComplete from formation_date before this year', () => {
    const r = classifyAccount(base({ formationDate: '2024-08-20' }))
    expect(r.formationComplete).toBe(true)
  })

  it('formationComplete from tax_returns row (double effect)', () => {
    const r = classifyAccount(base({
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
    }))
    expect(r.formationComplete).toBe(true)
  })

  it('NOT formationComplete: formed this year, no EIN, no SD completion', () => {
    const r = classifyAccount(base({
      formationDate: '2026-04-01',
      formationSD: { stage: 'State Filing', stageOrder: 2, status: 'active' },
    }))
    expect(r.formationComplete).toBe(false)
  })
})

// ═══════════════════════════════════════
// TAX RETURN EXPECTATION
// ═══════════════════════════════════════

describe('classifyAccount — tax return expectation', () => {
  it('taxReturnExpected: extension filed', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
    }))
    expect(r.taxReturnExpected).toBe(true)
    expect(r.extensionFiled).toBe(true)
    expect(r.taxReturnReason).toContain('Extension filed')
  })

  it('taxReturnExpected: active client with EIN, formed before this year', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-06-15',
    }))
    expect(r.taxReturnExpected).toBe(true)
    expect(r.taxReturnReason).toContain('formed before this year')
  })

  it('NOT taxReturnExpected: formed this year, no tax return', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2026-02-15',
    }))
    expect(r.taxReturnExpected).toBe(false)
    expect(r.taxReturnReason).toContain('formed in 2026')
  })

  it('NOT taxReturnExpected: first year skip', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2025-11-01',
      taxReturn: { taxYear: 2025, extensionFiled: false, status: 'Not Invoiced', firstYearSkip: true },
    }))
    expect(r.taxReturnExpected).toBe(false)
    expect(r.taxReturnReason).toContain('First-year skip')
  })

  it('NOT taxReturnExpected: new formation', () => {
    const r = classifyAccount(base({
      formationSD: { stage: 'State Filing', stageOrder: 2, status: 'active' },
    }))
    expect(r.taxReturnExpected).toBe(false)
    expect(r.taxReturnReason).toContain('Formation not complete')
  })

  it('NOT taxReturnExpected: One-Time without tax return', () => {
    const r = classifyAccount(base({
      accountType: 'One-Time',
      einNumber: '12-3456789',
      activeServiceTypes: ['CMRA Mailing Address'],
    }))
    expect(r.taxReturnExpected).toBe(false)
  })

  it('taxReturnExpected: One-Time WITH active tax return', () => {
    const r = classifyAccount(base({
      accountType: 'One-Time',
      einNumber: '12-3456789',
      activeServiceTypes: ['Tax Return'],
      taxReturn: { taxYear: 2025, extensionFiled: false, status: 'Data Received', firstYearSkip: false },
    }))
    expect(r.taxReturnExpected).toBe(true)
  })
})

// ═══════════════════════════════════════
// EXPECTED / MISSING / EXTRA SDs
// ═══════════════════════════════════════

describe('classifyAccount — service delivery expectations', () => {
  it('active_client expects standard bundle + tax return', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
      activeServiceTypes: ['State RA Renewal', 'State Annual Report', 'CMRA Mailing Address', 'Annual Renewal', 'Tax Return'],
    }))
    expect(r.expectedSDs).toHaveLength(5)
    expect(r.missingSDs).toHaveLength(0)
    expect(r.extraSDs).toHaveLength(0)
  })

  it('active_client with missing SDs', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      activeServiceTypes: ['State RA Renewal'],
    }))
    expect(r.missingSDs).toContain('State Annual Report')
    expect(r.missingSDs).toContain('CMRA Mailing Address')
    expect(r.missingSDs).toContain('Annual Renewal')
  })

  it('one_time expects nothing (no standard bundle)', () => {
    const r = classifyAccount(base({
      accountType: 'One-Time',
      einNumber: '12-3456789',
      activeServiceTypes: ['Tax Return'],
    }))
    expect(r.expectedSDs).toHaveLength(0)
    expect(r.missingSDs).toHaveLength(0)
  })

  it('new_formation expects only Company Formation', () => {
    const r = classifyAccount(base({
      formationSD: { stage: 'State Filing', stageOrder: 2, status: 'active' },
      activeServiceTypes: ['Company Formation'],
    }))
    expect(r.expectedSDs).toEqual(['Company Formation'])
    expect(r.missingSDs).toHaveLength(0)
  })

  it('extra SDs are reported (e.g. ITIN, Banking Fintech)', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      activeServiceTypes: ['State RA Renewal', 'State Annual Report', 'CMRA Mailing Address', 'Annual Renewal', 'ITIN', 'Banking Fintech'],
    }))
    expect(r.extraSDs).toContain('ITIN')
    expect(r.extraSDs).toContain('Banking Fintech')
  })

  it('Company Formation in actual SDs is not counted as extra', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2026-02-15',
      formationSD: { stage: 'Post-Formation', stageOrder: 5, status: 'active' },
      activeServiceTypes: ['Company Formation', 'State RA Renewal'],
    }))
    expect(r.extraSDs).not.toContain('Company Formation')
  })
})

// ═══════════════════════════════════════
// PENDING REASONS
// ═══════════════════════════════════════

describe('classifyAccount — pending reasons', () => {
  it('EIN pending: SS-4 submitted', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-15',
      formationSD: { stage: 'EIN Submitted', stageOrder: 4, status: 'active' },
      ss4: { status: 'submitted' },
    }))
    expect(r.pendingReasons.some(p => p.field === 'ein_number' && p.reason.includes('SS-4'))).toBe(true)
  })

  it('EIN missing but tax return exists (data entry gap)', () => {
    const r = classifyAccount(base({
      formationDate: '2024-01-01',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
    }))
    expect(r.pendingReasons.some(p => p.field === 'ein_number' && p.reason.includes('missing data entry'))).toBe(true)
  })

  it('formation in progress generates a pending reason', () => {
    const r = classifyAccount(base({
      formationSD: { stage: 'State Filing', stageOrder: 2, status: 'active' },
    }))
    expect(r.pendingReasons.some(p => p.field === 'formation' && p.reason.includes('State Filing'))).toBe(true)
  })

  it('tax return in progress generates a pending reason', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Data Received', firstYearSkip: false },
    }))
    expect(r.pendingReasons.some(p => p.field === 'tax_return' && p.reason.includes('Data Received'))).toBe(true)
  })

  it('no pending reasons for complete active client', () => {
    const r = classifyAccount(base({
      einNumber: '12-3456789',
      formationDate: '2024-01-01',
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Filed', firstYearSkip: false },
    }))
    expect(r.pendingReasons).toHaveLength(0)
  })
})

// ═══════════════════════════════════════
// REAL-WORLD CASE PATTERNS
// ═══════════════════════════════════════

describe('classifyAccount — real cases', () => {
  it('Nova Dynamics: active client, has EIN, no formation SD (legacy)', () => {
    const r = classifyAccount(base({
      einNumber: '35-2903710',
      formationDate: '2025-06-01',
      activeServiceTypes: ['CMRA Mailing Address', 'State Annual Report', 'State RA Renewal', 'Tax Return'],
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Data Received', firstYearSkip: false },
    }))
    expect(r.category).toBe('legacy_client')
    expect(r.formationComplete).toBe(true)
    expect(r.taxReturnExpected).toBe(true)
    expect(r.missingSDs).toContain('Annual Renewal')
  })

  it('Oh My Creatives: new formation at EIN Application', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-31',
      formationSD: { stage: 'EIN Application', stageOrder: 3, status: 'active' },
      activeServiceTypes: ['Company Formation'],
    }))
    expect(r.category).toBe('pending_ein')
    expect(r.formationInProgress).toBe(true)
    expect(r.isWaitingForEIN).toBe(true)
    expect(r.taxReturnExpected).toBe(false)
    expect(r.expectedSDs).toContain('State RA Renewal') // pending_ein gets standard bundle
    expect(r.missingSDs.length).toBeGreaterThan(0) // missing standard SDs is expected at this stage
  })

  it('Stepwell Dynamics: no EIN, no formation SD, has renewal SDs', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-13',
      activeServiceTypes: ['Annual Renewal', 'CMRA Mailing Address', 'State RA Renewal', 'State Annual Report'],
      // No tax return in this specific test case
    }))
    // Formed this year, no EIN, no formation SD, no tax return
    // formationInProgress = false, formationComplete = false (formed this year, not before)
    expect(r.category).toBe('incomplete')
  })

  it('Stepwell Dynamics WITH tax return: becomes legacy_client', () => {
    const r = classifyAccount(base({
      formationDate: '2026-03-13',
      activeServiceTypes: ['Annual Renewal', 'CMRA Mailing Address', 'State RA Renewal', 'State Annual Report'],
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
    }))
    // taxReturn exists → formationComplete = true → legacy_client
    expect(r.category).toBe('legacy_client')
    expect(r.formationComplete).toBe(true)
    expect(r.pendingReasons.some(p => p.reason.includes('missing data entry'))).toBe(true)
  })

  it('Pending Company (One-Time, Tax Return only)', () => {
    const r = classifyAccount(base({
      accountType: 'One-Time',
      activeServiceTypes: ['Tax Return'],
      taxReturn: { taxYear: 2025, extensionFiled: false, status: 'Payment Pending', firstYearSkip: false },
    }))
    expect(r.category).toBe('one_time')
    expect(r.expectedSDs).toHaveLength(0) // no standard bundle
    expect(r.taxReturnExpected).toBe(true) // has an active tax return
  })

  it('Cirock LLC: old formation (2021), has EIN, legacy', () => {
    const r = classifyAccount(base({
      einNumber: '85-1234567',
      formationDate: '2021-01-20',
      activeServiceTypes: ['State RA Renewal', 'State Annual Report', 'CMRA Mailing Address', 'Annual Renewal', 'Tax Return'],
      taxReturn: { taxYear: 2025, extensionFiled: true, status: 'Extension Filed', firstYearSkip: false },
    }))
    expect(r.category).toBe('legacy_client')
    expect(r.formationComplete).toBe(true)
    expect(r.missingSDs).toHaveLength(0)
    expect(r.taxReturnExpected).toBe(true)
  })
})

// ═══════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════

describe('constants', () => {
  it('STANDARD_CLIENT_SDS has 4 items', () => {
    expect(STANDARD_CLIENT_SDS).toHaveLength(4)
    expect(STANDARD_CLIENT_SDS).toContain('State RA Renewal')
    expect(STANDARD_CLIENT_SDS).toContain('State Annual Report')
    expect(STANDARD_CLIENT_SDS).toContain('CMRA Mailing Address')
    expect(STANDARD_CLIENT_SDS).toContain('Annual Renewal')
  })

  it('TAX_RETURN_SD is Tax Return', () => {
    expect(TAX_RETURN_SD).toBe('Tax Return')
  })
})
