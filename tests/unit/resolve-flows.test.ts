import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin so importing the module doesn't pull a live client.
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  yearOf,
  deriveFlowYear,
  flowStatusFromSd,
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
})

describe('flowStatusFromSd', () => {
  it('maps completed and active', () => {
    expect(flowStatusFromSd('completed')).toBe('completed')
    expect(flowStatusFromSd('active')).toBe('active')
    expect(flowStatusFromSd('blocked')).toBe('active')
    expect(flowStatusFromSd(null)).toBe('active')
  })
})

describe('mapSdToFlow', () => {
  it('maps SD fields and derives year', () => {
    const flow = mapSdToFlow(sd({ id: 'x', service_type: 'Tax Return', stage: 'Data Submitted', due_date: '2025-04-15' }), ACCOUNT)
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
