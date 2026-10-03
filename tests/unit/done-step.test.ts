import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  legacyStageCompletesService,
  stageCompletesService,
  pickDoneStep,
  NO_DONE_STEP_MESSAGE,
} from '@/lib/services/done-step'

/**
 * N1a F1 — the "done" step of each service. Parity: with the migration's seed, every step of every service closes a
 * job exactly when the old name rule did. Fixture = the production step lists of all 21 services (2026-10-02) plus
 * the sandbox's older 4-step renewal layout.
 */
const PROD_STEPS: Record<string, string[]> = {
  'Annual Renewal': ['Invoice Sent', 'Payment Received', 'Services Renewed'],
  'Banking Fintech': ['Data Collection', 'Application Submitted', 'Awaiting Verification', 'Account Opened'],
  'Banking Physical': ['Scheduling', 'Application Prepared', 'Bank Visit', 'Account Opened'],
  'Certificate of Incumbency': ['Requested', 'Received', 'Sent to Client'],
  'Client Onboarding': ['Data Collection', 'Review & CRM Setup', 'Post-Review & Closing'],
  'CMRA Mailing Address': ['Lease Created', 'Lease Signed', 'CMRA Active'],
  'Company Change Name': ['Collect three company names', 'Inform Client name available', 'File the change name form', 'Ship change name form to teh SoS', 'Form Change Name received from the SoS'],
  'Company Closure': ['Data Collection', 'State Compliance Check', 'State Dissolution Filing', 'IRS Closure', 'Closing'],
  'Company Formation': ['Payment Confirmed', 'Wizard Submitted', 'Filed with State', 'Articles Received', 'SS-4 Prepared', 'SS-4 Signed', 'SS-4 Sent to IRS', 'EIN Received'],
  'Consulting Call': ['To Schedule', 'Scheduled', 'Call Done'],
  DBA: ['Data Collection', 'Application Preparation', 'Publication', 'Filed with State', 'Registered', 'Renewal Due'],
  EIN: ['SS-4 Preparation', 'SS-4 Submitted', 'Awaiting EIN', 'EIN Received'],
  'EIN Change Name': ['File the form 8822-B', 'Ship to the IRS', 'Call the IRS', 'Name Changed'],
  ITIN: ['Data Collection', 'Document Preparation', 'Client Signing', 'Documents Received', 'CAA Review', 'Submitted to IRS', 'IRS Processing', 'ITIN Approved'],
  'Public Notary': ['Documents Received', 'Notarized', 'Returned to Client'],
  Shipping: ['Preparing Shipment', 'Shipped', 'Delivered'],
  'State Annual Report': ['Upcoming', 'In Progress', 'Completed'],
  'State RA Renewal': ['Upcoming', 'Renewal', 'Completed'],
  'Tax Return': ['Company Data Pending', 'Paid - Awaiting Data', '1st Installment Paid', 'Extension Filed', 'Awaiting 2nd Payment', '2nd Installment Paid', 'Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'Confirmed', 'Data Received', 'Preparation', 'TR Completed', 'TR Filed', 'Terminated - Non Payment'],
  'Tax Return One-Time': ['Payment Pending', 'Payment Received', 'Wizard Available', 'Data Received', 'Preparation', 'TR Completed', 'TR Filed', 'Terminated - Non Payment'],
  'TD Communication': ['Package Selected', 'Form Submitted', 'Brand Concept In Progress', 'Concept Ready', 'Concept Approved', 'Revision In Progress', 'Final Delivery'],
}
const SANDBOX_RENEWAL_STEPS: Record<string, string[]> = {
  'State RA Renewal': ['Renewal Due', 'Renewal Processed', 'Document Uploaded', 'Closed'],
  'State Annual Report': ['Due Date', 'Filed', 'Filing Receipt Uploaded', 'Closed'],
}

/** What the migration's UPDATE sets — kept literally in step with the SQL (checked below). */
function migrationSeed(stageName: string, serviceType: string): boolean {
  return ['Completed', 'TR Filed'].includes(stageName) ||
    (stageName === 'Closed' && ['State RA Renewal', 'State Annual Report'].includes(serviceType))
}

function seeded(serviceType: string, names: string[]) {
  return names.map((n, i) => ({ stage_name: n, stage_order: (i + 1) * 10, completes_service: migrationSeed(n, serviceType) }))
}

describe('parity — after the migration, every step closes a job exactly when the old name rule did', () => {
  for (const [serviceType, names] of Object.entries({ ...PROD_STEPS, ...SANDBOX_RENEWAL_STEPS })) {
    it(serviceType, () => {
      for (const s of seeded(serviceType, names)) {
        expect(stageCompletesService(s, serviceType)).toBe(legacyStageCompletesService(s.stage_name, serviceType))
      }
    })
  }
  it('the migration file seeds the same names as this test', () => {
    const sql = readFileSync(join(process.cwd(), 'scripts/migrations/20261003-0100-done-step.sql'), 'utf8')
    expect(sql).toContain("stage_name IN ('Completed', 'TR Filed')")
    expect(sql).toContain("stage_name = 'Closed' AND service_type IN ('State RA Renewal', 'State Annual Report')")
  })
})

describe('stageCompletesService', () => {
  it('uses the flag when present (a step can be done whatever its name)', () => {
    expect(stageCompletesService({ stage_name: 'Delivered', stage_order: 3, completes_service: true }, 'Shipping')).toBe(true)
    expect(stageCompletesService({ stage_name: 'Completed', stage_order: 3, completes_service: false }, 'X')).toBe(false)
  })
  it('falls back to the old name rule before the migration (no flag on the row)', () => {
    expect(stageCompletesService({ stage_name: 'Completed', stage_order: 3 }, 'State RA Renewal')).toBe(true)
    expect(stageCompletesService({ stage_name: 'TR Filed', stage_order: 80 }, 'Tax Return')).toBe(true)
    expect(stageCompletesService({ stage_name: 'Closed', stage_order: 40 }, 'State Annual Report')).toBe(true)
    expect(stageCompletesService({ stage_name: 'Closed', stage_order: 5 }, 'Company Closure')).toBe(false)
    expect(stageCompletesService({ stage_name: 'Closing', stage_order: 5 }, 'Company Closure')).toBe(false)
    expect(stageCompletesService({ stage_name: 'Delivered', stage_order: 3, completes_service: null }, 'Shipping')).toBe(false)
  })
})

describe('pickDoneStep — where "Mark complete" goes', () => {
  it('a tax return goes to "TR Filed", never to "Terminated - Non Payment" (the old bug)', () => {
    expect(pickDoneStep(seeded('Tax Return', PROD_STEPS['Tax Return']))?.stage_name).toBe('TR Filed')
    expect(pickDoneStep(seeded('Tax Return One-Time', PROD_STEPS['Tax Return One-Time']))?.stage_name).toBe('TR Filed')
  })
  it('the renewals go to their done step', () => {
    expect(pickDoneStep(seeded('State RA Renewal', PROD_STEPS['State RA Renewal']))?.stage_name).toBe('Completed')
    expect(pickDoneStep(seeded('State Annual Report', SANDBOX_RENEWAL_STEPS['State Annual Report']))?.stage_name).toBe('Closed')
  })
  it('a service with no done step returns null (Mark complete refuses) — e.g. ITIN, Shipping, CMRA, Formation', () => {
    for (const t of ['ITIN', 'Shipping', 'CMRA Mailing Address', 'Company Formation', 'DBA']) {
      expect(pickDoneStep(seeded(t, PROD_STEPS[t]))).toBeNull()
    }
    expect(NO_DONE_STEP_MESSAGE).toMatch(/no "done" step/)
  })
  it('before the migration (no flag anywhere) keeps the old behaviour: the highest-numbered step', () => {
    const raw = PROD_STEPS['Shipping'].map((n, i) => ({ stage_name: n, stage_order: i + 1 }))
    expect(pickDoneStep(raw)?.stage_name).toBe('Delivered')
  })
  it('several marked steps: the highest-numbered marked one; empty list: null', () => {
    const s = [
      { stage_name: 'A', stage_order: 1, completes_service: true },
      { stage_name: 'B', stage_order: 2, completes_service: true },
      { stage_name: 'C', stage_order: 3, completes_service: false },
    ]
    expect(pickDoneStep(s)?.stage_name).toBe('B')
    expect(pickDoneStep([])).toBeNull()
  })
})
