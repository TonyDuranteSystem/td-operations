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
    const steps = buildFlowSteps(TAX_STAGES, 'Wizard Available', 'en')
    expect(steps).not.toBeNull()
    expect(steps!.map(s => s.label)).toEqual([
      'Extension Due', 'Complete Your Tax Form', 'Under Review', 'Completed',
    ])
    expect(steps!.map(s => s.state)).toEqual(['completed', 'current', 'future', 'future'])
  })

  it('resolves IT labels with EN fallback', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Extension Due', 'it')!
    expect(steps[0].label).toBe('Proroga')
    expect(steps[2].label).toBe('Under Review') // no IT label → EN fallback
  })

  it('keeps the previous labelled step current on an internal stage', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Data Received', 'en')!
    expect(steps.find(s => s.state === 'current')?.label).toBe('Complete Your Tax Form')
  })

  it('marks all steps future when not yet started / unknown stage', () => {
    const steps = buildFlowSteps(TAX_STAGES, 'Some Legacy Stage', 'en')!
    expect(steps.every(s => s.state === 'future')).toBe(true)
  })

  it('returns null for a flow with no client-facing stages (CMRA)', () => {
    expect(buildFlowSteps(CMRA_STAGES, 'Lease Created', 'en')).toBeNull()
  })

  it('carries the catalog icon through when present', () => {
    const withIcon: FlowStageRow[] = [
      { stage_name: 'A', stage_order: 10, client_label: 'Step A', client_label_it: null, icon: '📝' },
    ]
    expect(buildFlowSteps(withIcon, 'A', 'en')![0].icon).toBe('📝')
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
