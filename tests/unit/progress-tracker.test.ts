import { describe, it, expect } from 'vitest'
import { buildTrackerSteps, type TrackerCatalogStage } from '@/lib/tax/progress-tracker'

// Mirror of the sandbox/prod Tax Return catalog after Slice 1 + the
// client_label_it migration (20260610-1900). 17 stages, 13 labelled.
const CATALOG: TrackerCatalogStage[] = [
  { stage_name: 'Company Data Pending', stage_order: -10, client_label: null, client_label_it: null, icon: null },
  { stage_name: 'Paid - Awaiting Data', stage_order: 0, client_label: null, client_label_it: null, icon: null },
  { stage_name: '1st Installment Paid', stage_order: 10, client_label: '1st Installment Paid', client_label_it: 'Prima Rata Pagata', icon: '💰' },
  { stage_name: 'Extension Filed', stage_order: 20, client_label: 'Extension Filed', client_label_it: 'Proroga Presentata', icon: '📄' },
  { stage_name: 'Awaiting 2nd Payment', stage_order: 30, client_label: 'Waiting for 2nd Installment', client_label_it: 'In Attesa della Seconda Rata', icon: '⏳' },
  { stage_name: '2nd Installment Paid', stage_order: 35, client_label: '2nd Installment Paid', client_label_it: 'Seconda Rata Pagata', icon: '💰' },
  { stage_name: 'Wizard Available', stage_order: 40, client_label: 'Wizard Available', client_label_it: 'Modulo Disponibile', icon: '📨' },
  { stage_name: 'Data Submitted', stage_order: 45, client_label: 'Data Submitted', client_label_it: 'Dati Inviati', icon: '📝' },
  { stage_name: 'Under Review', stage_order: 46, client_label: 'Under Review', client_label_it: 'In Revisione', icon: '🔍' },
  { stage_name: 'Revision Requested', stage_order: 47, client_label: 'Revision Requested', client_label_it: 'Modifiche Richieste', icon: '⚠️' },
  { stage_name: 'Approved', stage_order: 48, client_label: 'Approved', client_label_it: 'Approvato', icon: '✅' },
  { stage_name: 'Confirmed', stage_order: 49, client_label: 'Confirmed', client_label_it: 'Confermato', icon: '🔒' },
  { stage_name: 'Data Received', stage_order: 50, client_label: null, client_label_it: null, icon: null },
  { stage_name: 'Preparation', stage_order: 60, client_label: 'With Accountant', client_label_it: 'Dal Commercialista', icon: '📊' },
  { stage_name: 'TR Completed', stage_order: 70, client_label: 'Ready to Sign', client_label_it: 'Pronto per la Firma', icon: '✍️' },
  { stage_name: 'TR Filed', stage_order: 80, client_label: 'Filed', client_label_it: 'Presentata', icon: '📬' },
  { stage_name: 'Terminated - Non Payment', stage_order: 90, client_label: null, client_label_it: null, icon: null },
]

describe('buildTrackerSteps', () => {
  it('renders 13 labelled steps with the first stage current at 1st Installment Paid', () => {
    const steps = buildTrackerSteps(CATALOG, '1st Installment Paid', 'en')
    expect(steps).not.toBeNull()
    expect(steps!.length).toBe(13)
    expect(steps![0].state).toBe('current')
    expect(steps!.slice(1).every(s => s.state === 'future')).toBe(true)
  })

  it('marks earlier stages completed and later future at a mid stage', () => {
    const steps = buildTrackerSteps(CATALOG, 'Under Review', 'en')!
    const byName = Object.fromEntries(steps.map(s => [s.stageName, s.state]))
    expect(byName['1st Installment Paid']).toBe('completed')
    expect(byName['Data Submitted']).toBe('completed')
    expect(byName['Under Review']).toBe('current')
    expect(byName['Approved']).toBe('future')
    expect(byName['TR Filed']).toBe('future')
  })

  it('keeps Confirmed highlighted while SD sits at internal Data Received (50)', () => {
    const steps = buildTrackerSteps(CATALOG, 'Data Received', 'en')!
    const current = steps.find(s => s.state === 'current')
    expect(current?.stageName).toBe('Confirmed')
  })

  it('marks everything completed except current at TR Filed (terminal happy path)', () => {
    const steps = buildTrackerSteps(CATALOG, 'TR Filed', 'en')!
    expect(steps[steps.length - 1].state).toBe('current')
    expect(steps.slice(0, -1).every(s => s.state === 'completed')).toBe(true)
  })

  it('hides the tracker before 1st Installment Paid (standalone intake stages)', () => {
    expect(buildTrackerSteps(CATALOG, 'Company Data Pending', 'en')).toBeNull()
    expect(buildTrackerSteps(CATALOG, 'Paid - Awaiting Data', 'en')).toBeNull()
  })

  it('hides the tracker on Terminated - Non Payment', () => {
    expect(buildTrackerSteps(CATALOG, 'Terminated - Non Payment', 'en')).toBeNull()
  })

  it('hides the tracker for unknown/legacy stage names', () => {
    expect(buildTrackerSteps(CATALOG, 'Data Link Sent', 'en')).toBeNull()
    expect(buildTrackerSteps(CATALOG, '', 'en')).toBeNull()
  })

  it('hides the tracker when stage is null', () => {
    expect(buildTrackerSteps(CATALOG, null, 'en')).toBeNull()
  })

  it('resolves Italian labels with fallback to English', () => {
    const steps = buildTrackerSteps(CATALOG, 'Preparation', 'it')!
    const current = steps.find(s => s.state === 'current')
    expect(current?.label).toBe('Dal Commercialista')
  })

  it('falls back to client_label when client_label_it is missing', () => {
    const catalog = CATALOG.map(s =>
      s.stage_name === 'Approved' ? { ...s, client_label_it: null } : s,
    )
    const steps = buildTrackerSteps(catalog, 'Approved', 'it')!
    const current = steps.find(s => s.state === 'current')
    expect(current?.label).toBe('Approved')
  })

  it('returns null for an empty catalog', () => {
    expect(buildTrackerSteps([], 'Under Review', 'en')).toBeNull()
  })

  it('ignores unlabelled stages in the step list', () => {
    const steps = buildTrackerSteps(CATALOG, 'Wizard Available', 'en')!
    expect(steps.some(s => s.stageName === 'Data Received')).toBe(false)
    expect(steps.some(s => s.stageName === 'Company Data Pending')).toBe(false)
  })

  describe('review_status overlay (SD parks at Data Submitted through the review loop)', () => {
    it('moves the dot to Approved when staff approved but SD is still at Data Submitted', () => {
      const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', 'approved')!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Approved')
      expect(steps.find(s => s.stageName === 'Under Review')?.state).toBe('completed')
    })

    it('moves the dot to Under Review on under_review', () => {
      const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', 'under_review')!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Under Review')
    })

    it('moves the dot to Revision Requested on revision_requested', () => {
      const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', 'revision_requested')!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Revision Requested')
    })

    it('keeps Data Submitted current on submitted/resubmitted/reopened', () => {
      for (const rs of ['submitted', 'resubmitted', 'reopened']) {
        const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', rs)!
        expect(steps.find(s => s.state === 'current')?.stageName).toBe('Data Submitted')
      }
    })

    it('never drags an advanced SD backwards (stale confirmed vs SD at Preparation)', () => {
      const steps = buildTrackerSteps(CATALOG, 'Preparation', 'en', 'confirmed')!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Preparation')
    })

    it('ignores unknown review_status values', () => {
      const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', 'bogus_state')!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Data Submitted')
    })

    it('ignores null review_status', () => {
      const steps = buildTrackerSteps(CATALOG, 'Data Submitted', 'en', null)!
      expect(steps.find(s => s.state === 'current')?.stageName).toBe('Data Submitted')
    })
  })
})
