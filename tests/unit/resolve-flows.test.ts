import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin so importing the module doesn't pull a live client.
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  yearOf,
  deriveFlowYear,
  taxReturnYear,
  taxYearFromServiceName,
  flowStatusFromSd,
  buildFlowTopic,
  buildScheduledFlows,
  assembleFlows,
  mapSdToFlow,
  type SdRow,
  type AccountDates,
} from '@/lib/flows/resolve-flows'

const ACCOUNT: AccountDates = {
  id: 'acc-1',
  company_name: 'Acme LLC',
  ra_renewal_date: '2026-09-01',
  annual_report_due_date: '2026-11-15',
}

function sd(partial: Partial<SdRow>): SdRow {
  return {
    id: 'sd-1',
    service_type: 'Tax Return',
    stage: 'Wizard Available',
    stage_order: null,
    status: 'active',
    due_date: null,
    stage_entered_at: null,
    created_at: null,
    account_id: 'acc-1',
    ...partial,
  }
}

describe('yearOf', () => {
  it('parses ISO date and timestamp', () => {
    expect(yearOf('2025-04-15')).toBe(2025)
    expect(yearOf('2026-01-01T12:00:00Z')).toBe(2026)
  })
  it('returns null for empty/invalid', () => {
    expect(yearOf(null)).toBeNull()
    expect(yearOf(undefined)).toBeNull()
    expect(yearOf('')).toBeNull()
    expect(yearOf('not-a-date')).toBeNull()
    expect(yearOf('1800-01-01')).toBeNull()
  })
})

describe('deriveFlowYear', () => {
  it('prefers due_date, then stage_entered_at, then created_at', () => {
    expect(deriveFlowYear({ due_date: '2025-04-15', stage_entered_at: '2024-01-01', created_at: '2023-01-01' })).toBe(2025)
    expect(deriveFlowYear({ due_date: null, stage_entered_at: '2024-06-01', created_at: '2023-01-01' })).toBe(2024)
    expect(deriveFlowYear({ due_date: null, stage_entered_at: null, created_at: '2023-01-01' })).toBe(2023)
  })
  it('returns null when no date parses', () => {
    expect(deriveFlowYear({ due_date: null, stage_entered_at: null, created_at: null })).toBeNull()
  })
  it('leaves every service other than Tax Return on the date year', () => {
    expect(deriveFlowYear({ service_type: 'State Annual Report', due_date: '2026-11-15', stage_entered_at: null, created_at: '2026-01-02' })).toBe(2026)
    expect(deriveFlowYear({ service_type: 'ITIN', due_date: null, stage_entered_at: '2026-06-01', created_at: '2026-01-02' })).toBe(2026)
  })
})

describe('taxReturnYear / deriveFlowYear for a Tax Return', () => {
  // Production 2026-11-05: all 232 Tax Return SDs have no deadline and were created in 2026 for tax year 2025.
  it('is the year BEFORE the filing year: a pipeline created in 2026 is the 2025 return', () => {
    expect(taxReturnYear({ due_date: null, stage_entered_at: '2026-10-07T15:55:54Z', created_at: '2026-03-05T10:00:00Z' })).toBe(2025)
    expect(deriveFlowYear({ service_type: 'Tax Return', due_date: null, stage_entered_at: '2026-10-07T15:55:54Z', created_at: '2026-03-05T10:00:00Z' })).toBe(2025)
  })
  it('does not move when staff advance the job: stage_entered_at is only a fallback', () => {
    expect(taxReturnYear({ due_date: null, stage_entered_at: '2027-01-10T00:00:00Z', created_at: '2026-03-05T10:00:00Z' })).toBe(2025)
  })
  it('uses the deadline when one is stored (April or October of the filing year)', () => {
    expect(taxReturnYear({ due_date: '2026-04-15', stage_entered_at: null, created_at: '2026-03-05T10:00:00Z' })).toBe(2025)
    expect(taxReturnYear({ due_date: '2026-10-15', stage_entered_at: null, created_at: null })).toBe(2025)
  })
  it('falls back to the last stage move, then to nothing', () => {
    expect(taxReturnYear({ due_date: null, stage_entered_at: '2026-08-01T00:00:00Z', created_at: null })).toBe(2025)
    expect(taxReturnYear({ due_date: null, stage_entered_at: null, created_at: null })).toBeNull()
  })
  it('builds the chat tab and workspace title "Tax Return 2025" for a 2025 return worked in 2026', () => {
    const row = { service_type: 'Tax Return', due_date: null, stage_entered_at: '2026-10-07T15:55:54Z', created_at: '2026-03-05T10:00:00Z' }
    expect(buildFlowTopic(row.service_type, deriveFlowYear(row))).toBe('Tax Return 2025')
  })
})

describe('taxYearFromServiceName / a pipeline that states its own tax year', () => {
  it('reads the year the creators write (year first, year last)', () => {
    expect(taxYearFromServiceName('Tax Return 2025 - Financialot LLC (Final Return)')).toBe(2025)
    expect(taxYearFromServiceName('Tax Return - Infinity Commerce Group LLC 2026')).toBe(2026)
  })
  it('never reads a year that belongs to the company name', () => {
    expect(taxYearFromServiceName('Tax Return - Studio 2024 LLC')).toBeNull()
    expect(taxYearFromServiceName('Tax Return 2025 - Studio 2024 LLC')).toBe(2025)
    expect(taxYearFromServiceName('Tax Return')).toBeNull()
    expect(taxYearFromServiceName(null)).toBeNull()
    expect(taxYearFromServiceName('Annual Report 2026 - Acme LLC')).toBeNull()
  })
  it('a pipeline named for 2026 (the onboarding job) stays 2026 even though it was created in 2026', () => {
    const row = { service_type: 'Tax Return', service_name: 'Tax Return - Solitude Consulting Llc 2026', due_date: null, stage_entered_at: '2026-10-07T00:00:00Z', created_at: '2026-08-13T00:00:00Z' }
    expect(taxReturnYear(row)).toBe(2026)
    expect(buildFlowTopic(row.service_type, deriveFlowYear(row))).toBe('Tax Return 2026')
  })
  it('the usual plain "Tax Return" name still falls back to the opening year minus one', () => {
    const row = { service_type: 'Tax Return', service_name: 'Tax Return', due_date: null, stage_entered_at: '2026-10-07T00:00:00Z', created_at: '2026-03-20T00:00:00Z' }
    expect(taxReturnYear(row)).toBe(2025)
  })
})

describe('flowStatusFromSd', () => {
  it('maps completed and active', () => {
    expect(flowStatusFromSd('completed')).toBe('completed')
    expect(flowStatusFromSd('active')).toBe('active')
    expect(flowStatusFromSd('blocked')).toBe('active')
    expect(flowStatusFromSd(null)).toBe('active')
  })
})

describe('buildFlowTopic', () => {
  it('appends the year when known', () => {
    expect(buildFlowTopic('Tax Return', 2025)).toBe('Tax Return 2025')
    expect(buildFlowTopic('State Annual Report', 2026)).toBe('State Annual Report 2026')
  })
  it('omits the year when null/undefined', () => {
    expect(buildFlowTopic('Tax Return', null)).toBe('Tax Return')
    expect(buildFlowTopic('Tax Return', undefined)).toBe('Tax Return')
  })
  it('trims and returns "" for an empty service type', () => {
    expect(buildFlowTopic('  Tax Return  ', 2025)).toBe('Tax Return 2025')
    expect(buildFlowTopic('', 2025)).toBe('')
    expect(buildFlowTopic(null, 2025)).toBe('')
    expect(buildFlowTopic('   ', 2025)).toBe('')
  })
})

describe('mapSdToFlow', () => {
  it('maps SD fields and derives year', () => {
    // A Tax Return due in April 2026 is the 2025 return (the year is the TAX year).
    const flow = mapSdToFlow(sd({ id: 'x', service_type: 'Tax Return', stage: 'Data Submitted', due_date: '2026-04-15' }), ACCOUNT)
    expect(flow).toMatchObject({
      flow_type: 'Tax Return',
      service_delivery_id: 'x',
      stage_name: 'Data Submitted',
      year: 2025,
      status: 'active',
      account_id: 'acc-1',
      company_name: 'Acme LLC',
    })
  })
})

describe('buildScheduledFlows', () => {
  it('emits RA + AR placeholders when no live SD exists for them', () => {
    const out = buildScheduledFlows(ACCOUNT, new Set())
    const types = out.map((f) => f.flow_type).sort()
    expect(types).toEqual(['State Annual Report', 'State RA Renewal'])
    const ra = out.find((f) => f.flow_type === 'State RA Renewal')!
    expect(ra.status).toBe('scheduled')
    expect(ra.service_delivery_id).toBeNull()
    expect(ra.due_date).toBe('2026-09-01')
    expect(ra.year).toBe(2026)
  })
  it('suppresses a placeholder when a live SD covers that type', () => {
    const out = buildScheduledFlows(ACCOUNT, new Set(['State RA Renewal']))
    expect(out.map((f) => f.flow_type)).toEqual(['State Annual Report'])
  })
  it('omits a placeholder when the account has no date for it', () => {
    const out = buildScheduledFlows({ ...ACCOUNT, ra_renewal_date: null }, new Set())
    expect(out.map((f) => f.flow_type)).toEqual(['State Annual Report'])
  })
})

describe('assembleFlows', () => {
  it('combines live SDs (filtered to flow types) with scheduled placeholders', () => {
    const sds: SdRow[] = [
      sd({ id: 'tr', service_type: 'Tax Return', stage: 'Wizard Available' }),
      sd({ id: 'cmra', service_type: 'CMRA Mailing Address', stage: 'Lease Signed' }),
      sd({ id: 'other', service_type: 'Company Formation', stage: 'Filed' }), // ignored
    ]
    const out = assembleFlows(ACCOUNT, sds)
    const byType = out.map((f) => f.flow_type).sort()
    // TR + CMRA live, plus RA + AR scheduled (no live SD for those)
    expect(byType).toEqual(['CMRA Mailing Address', 'State Annual Report', 'State RA Renewal', 'Tax Return'])
    expect(out.find((f) => f.flow_type === 'Company Formation' as never)).toBeUndefined()
  })
  it('does not add a scheduled RA placeholder when a live RA SD exists', () => {
    const sds: SdRow[] = [sd({ id: 'ra', service_type: 'State RA Renewal', stage: 'Renewal Due' })]
    const out = assembleFlows(ACCOUNT, sds)
    const ra = out.filter((f) => f.flow_type === 'State RA Renewal')
    expect(ra).toHaveLength(1)
    expect(ra[0].service_delivery_id).toBe('ra')
    expect(ra[0].status).toBe('active')
  })
})
