import { describe, it, expect } from 'vitest'
import { computeFlowProgress, buildFlowSteps, buildJourneySteps, type FlowStageRow } from '@/lib/flows/flow-progress'

// Minimal Tax-Return-like labelled flow (subset of the real catalog).
const TAX_STAGES: FlowStageRow[] = [
  { stage_name: 'Extension Due', stage_order: 10, client_label: 'Extension Due', client_label_it: 'Proroga' },
  { stage_name: 'Wizard Available', stage_order: 50, client_label: 'Complete Your Tax Form', client_label_it: 'Compila il Modulo' },
  { stage_name: 'Data Received', stage_order: 55, client_label: null, client_label_it: null }, // internal
  { stage_name: 'Under Review', stage_order: 65, client_label: 'Under Review', client_label_it: null },
  { stage_name: 'Completed', stage_order: 100, client_label: 'Completed', client_label_it: 'Completato' },
]

// CMRA-like flow: no client_label anywhere.
const CMRA_STAGES: FlowStageRow[] = [
  { stage_name: 'Lease Created', stage_order: 1, client_label: null, client_label_it: null },
]

// ITIN dashboard-stepper fixture — unlike ITIN_SANDBOX/ITIN_PROD below (built
// for buildJourneySteps, which needs client_description not client_label),
// this one carries client_label so buildFlowSteps includes it in the
// labelled journey, covering both of ITIN's real action-stage-registry
// entries (Data Collection, Client Signing).
const ITIN_PROD_LABELLED: FlowStageRow[] = [
  { stage_name: 'Data Collection', stage_order: 1, client_label: 'Completing ITIN wizard', client_label_it: null },
  { stage_name: 'Document Preparation', stage_order: 2, client_label: 'Documents being prepared', client_label_it: null },
  { stage_name: 'Client Signing', stage_order: 3, client_label: 'Print, sign & mail documents', client_label_it: null },
]

describe('computeFlowProgress', () => {
  it('counts labelled stages and resolves the current EN label', () => {
    const p = computeFlowProgress(TAX_STAGES, 'Wizard Available', 'en')
    expect(p.totalStages).toBe(4) // Extension, Wizard, Under Review, Completed
    expect(p.completedStages).toBe(2)
    expect(p.currentLabel).toBe('Complete Your Tax Form')
  })

  it('prefers the IT label when present and falls back to EN otherwise', () => {
    expect(computeFlowProgress(TAX_STAGES, 'Wizard Available', 'it').currentLabel).toBe('Compila il Modulo')
    // Under Review has no IT label → falls back to EN.
    expect(computeFlowProgress(TAX_STAGES, 'Under Review', 'it').currentLabel).toBe('Under Review')
  })

  it('keeps the previous labelled step highlighted on an internal stage', () => {
    // "Data Received" (55) is unlabelled and sits between Wizard (50) and
    // Under Review (65) — the active step stays Wizard (#2).
    const p = computeFlowProgress(TAX_STAGES, 'Data Received', 'en')
    expect(p.completedStages).toBe(2)
    expect(p.currentLabel).toBe('Complete Your Tax Form')
  })

  it('marks the final stage complete (full progress)', () => {
    const p = computeFlowProgress(TAX_STAGES, 'Completed', 'en')
    expect(p.completedStages).toBe(4)
    expect(p.totalStages).toBe(4)
  })

  it('returns totalStages=0 for a flow with no client labels (CMRA)', () => {
    const p = computeFlowProgress(CMRA_STAGES, 'Lease Created', 'en')
    expect(p).toEqual({ completedStages: 0, totalStages: 0, currentLabel: null })
  })

  it('does not start the journey for an unknown/legacy stage name', () => {
    const p = computeFlowProgress(TAX_STAGES, 'Some Legacy Stage', 'en')
    expect(p.completedStages).toBe(0)
    expect(p.totalStages).toBe(4)
    expect(p.currentLabel).toBeNull()
  })

  it('handles a null current stage without throwing', () => {
    const p = computeFlowProgress(TAX_STAGES, null, 'en')
    expect(p.completedStages).toBe(0)
    expect(p.currentLabel).toBeNull()
  })
})

describe('buildFlowSteps', () => {
  it('returns one step per labelled stage with completed/current/future states', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Wizard Available', 'en', 'Tax Return', 'sd-1')
    expect(steps).not.toBeNull()
    expect(steps!.map(s => s.label)).toEqual([
      'Extension Due', 'Complete Your Tax Form', 'Under Review', 'Completed',
    ])
    expect(steps!.map(s => s.state)).toEqual(['completed', 'current', 'future', 'future'])
  })

  it('resolves IT labels with EN fallback', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Extension Due', 'it', 'Tax Return', 'sd-1')!
    expect(steps[0].label).toBe('Proroga')
    expect(steps[2].label).toBe('Under Review') // no IT label → EN fallback
  })

  it('keeps the previous labelled step current on an internal stage', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Data Received', 'en', 'Tax Return', 'sd-1')!
    expect(steps.find(s => s.state === 'current')?.label).toBe('Complete Your Tax Form')
  })

  it('marks all steps future when not yet started / unknown stage', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Some Legacy Stage', 'en', 'Tax Return', 'sd-1')!
    expect(steps.every(s => s.state === 'future')).toBe(true)
  })

  it('returns null for a flow with no client-facing stages (CMRA)', () => {
    expect(buildFlowSteps(CMRA_STAGES, 'Lease Created', 'en', 'CMRA Mailing Address', 'sd-1')).toBeNull()
  })

  it('carries the catalog icon through when present', () => {
    const withIcon: FlowStageRow[] = [
      { stage_name: 'A', stage_order: 10, client_label: 'Step A', client_label_it: null, icon: '📝' },
    ]
    expect(buildFlowSteps(withIcon, 'A', 'en', 'Some Service', 'sd-1')![0].icon).toBe('📝')
  })

  // ── isActionRequired / actionHref: the dashboard-stepper "your turn" glow ──
  // Drawn from the SAME registry (action-stage-registry.ts) that already
  // drives the client email/chat/bell dispatch, so both surfaces agree on
  // what counts as "your turn" — and a stage NOT in that registry (most of
  // them — TD or the IRS working) must never glow, even while current.
  it('flags the current stage as action-required when the registry has it, with its link', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Wizard Available', 'en', 'Tax Return', 'sd-1')!
    const wizardStep = steps.find(s => s.stageName === 'Wizard Available')!
    expect(wizardStep.isActionRequired).toBe(true)
    expect(wizardStep.actionHref).toBe('/portal/wizard')
  })

  it('does not flag a current stage the registry has no entry for (TD/IRS working, not the client)', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Under Review', 'en', 'Tax Return', 'sd-1')!
    const step = steps.find(s => s.stageName === 'Under Review')!
    expect(step.isActionRequired).toBe(false)
    expect(step.actionHref).toBeNull()
  })

  it('interpolates {sd_id} into the action link (ITIN Client Signing)', () => {
    const steps = buildFlowSteps(ITIN_PROD_LABELLED, 'Client Signing', 'en', 'ITIN', 'sd-abc-123')!
    const step = steps.find(s => s.stageName === 'Client Signing')!
    expect(step.isActionRequired).toBe(true)
    expect(step.actionHref).toBe('/portal/flows/sd-abc-123')
  })

  it('never flags a COMPLETED step, even if its stage is a registered action stage', () => {
    // Data Collection is registered ('ITIN::Data Collection') but the SD has
    // already moved past it — a client already at Client Signing must not see
    // "your turn" glowing on a step they already finished.
    const steps = buildFlowSteps(ITIN_PROD_LABELLED, 'Client Signing', 'en', 'ITIN', 'sd-1')!
    const dataCollection = steps.find(s => s.stageName === 'Data Collection')!
    expect(dataCollection.state).toBe('completed')
    expect(dataCollection.isActionRequired).toBe(false)
    expect(dataCollection.actionHref).toBeNull()
  })
})

// ITIN-like flow: descriptions on every stage. Sandbox has NO client_label;
// production DOES — buildJourneySteps must work either way.
const ITIN_SANDBOX: FlowStageRow[] = [
  { stage_name: 'Document Preparation', stage_order: 2, client_label: null, client_label_it: null, client_description: 'Preparing your W-7 and tax forms.' },
  { stage_name: 'Client Signing', stage_order: 3, client_label: null, client_label_it: null, client_description: 'Print, sign, and mail to our office.' },
  { stage_name: 'Documents Received', stage_order: 4, client_label: null, client_label_it: null, client_description: 'We received your signed documents.' },
]

const ITIN_PROD: FlowStageRow[] = [
  { stage_name: 'Document Preparation', stage_order: 2, client_label: 'Documents being prepared', client_label_it: null, client_description: 'Preparing your W-7 and tax forms.' },
  { stage_name: 'Client Signing', stage_order: 3, client_label: 'Print, sign & mail documents', client_label_it: 'Stampa e spedisci', client_description: 'Print, sign, and mail to our office.' },
  { stage_name: 'Documents Received', stage_order: 4, client_label: 'Documents received', client_label_it: null, client_description: 'We received your signed documents.' },
]

describe('buildJourneySteps', () => {
  it('includes EVERY stage (unlike buildFlowSteps) with description + state', () => {
    const steps = buildJourneySteps(ITIN_SANDBOX, 'Client Signing', 'en')
    expect(steps.map(s => s.stageName)).toEqual(['Document Preparation', 'Client Signing', 'Documents Received'])
    expect(steps.map(s => s.state)).toEqual(['completed', 'current', 'future'])
    expect(steps[1].description).toBe('Print, sign, and mail to our office.')
  })

  it('falls back to stage_name as the label when no client_label (sandbox ITIN)', () => {
    const steps = buildJourneySteps(ITIN_SANDBOX, 'Client Signing', 'en')
    expect(steps[1].label).toBe('Client Signing')
  })

  it('uses client_label when present (production ITIN), IT then EN fallback', () => {
    expect(buildJourneySteps(ITIN_PROD, 'Client Signing', 'en')[1].label).toBe('Print, sign & mail documents')
    expect(buildJourneySteps(ITIN_PROD, 'Client Signing', 'it')[1].label).toBe('Stampa e spedisci')
    // Document Preparation has no IT label → EN fallback.
    expect(buildJourneySteps(ITIN_PROD, 'Client Signing', 'it')[0].label).toBe('Documents being prepared')
  })

  it('marks all stages future for an unknown/legacy current stage', () => {
    expect(buildJourneySteps(ITIN_PROD, 'Nonexistent', 'en').every(s => s.state === 'future')).toBe(true)
  })

  it('handles a null current stage without throwing', () => {
    expect(buildJourneySteps(ITIN_PROD, null, 'en').every(s => s.state === 'future')).toBe(true)
  })

  it('marks the last stage current+completed-before when at the end', () => {
    const steps = buildJourneySteps(ITIN_PROD, 'Documents Received', 'en')
    expect(steps.map(s => s.state)).toEqual(['completed', 'completed', 'current'])
  })
})

// ── The "start your application" call-to-action gate ────────────────────────
// The client's ITIN journey shows a Start button ONLY while the FIRST step is
// the current one. The page computes exactly this predicate, so pin it here.
//
// Why positional and not the stage NAME: stage names are editable from the
// service editor, and that editor DELETES and re-inserts stage rows, so a name
// is not a safe key. Position survives a rename.
//
// Why it matters that it can never fire late: three ITIN clients have
// applications already AT THE IRS (verified in production 2026-07-22). Showing
// any of them "start your application" would be worse than showing nothing.
const ITIN_STAGES: FlowStageRow[] = [
  { stage_name: 'Data Collection', stage_order: 1, client_label: 'Completing ITIN wizard', client_label_it: 'Compilazione wizard ITIN' },
  { stage_name: 'Document Preparation', stage_order: 2, client_label: 'Documents being prepared', client_label_it: null },
  { stage_name: 'Client Signing', stage_order: 3, client_label: 'Print, sign & mail documents', client_label_it: null },
  { stage_name: 'IRS Processing', stage_order: 7, client_label: 'IRS is processing your application', client_label_it: null },
  { stage_name: 'ITIN Approved', stage_order: 8, client_label: 'ITIN approved!', client_label_it: null },
]

/** Mirrors the page's predicate: is the first journey step the current one? */
const atFirstStep = (stage: string | null) => {
  const j = buildJourneySteps(ITIN_STAGES, stage, 'en')
  return j.length > 0 && j[0].state === 'current'
}

describe('ITIN start-your-application gate', () => {
  it('shows at the first step — the only stage waiting on the client', () => {
    expect(atFirstStep('Data Collection')).toBe(true)
  })

  it('is GONE at every later stage, including after the IRS has the application', () => {
    expect(atFirstStep('Document Preparation')).toBe(false)
    expect(atFirstStep('Client Signing')).toBe(false)
    expect(atFirstStep('IRS Processing')).toBe(false)
    expect(atFirstStep('ITIN Approved')).toBe(false)
  })

  it('stays hidden when the stage is unknown or missing — fails closed', () => {
    // A renamed stage resolves to no current step; the journey renders all
    // steps as future. Silence is the correct degradation, never a CTA.
    expect(atFirstStep('Renamed By Someone In The Editor')).toBe(false)
    expect(atFirstStep(null)).toBe(false)
  })

  it('survives a rename of the first stage — position is the key, not the name', () => {
    const renamed: FlowStageRow[] = [
      { ...ITIN_STAGES[0], stage_name: 'Raccolta Dati' },
      ...ITIN_STAGES.slice(1),
    ]
    const j = buildJourneySteps(renamed, 'Raccolta Dati', 'en')
    expect(j[0].state).toBe('current')
  })
})
