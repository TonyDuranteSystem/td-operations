/**
 * The workspace GUIDE's rules (lib/flows/workspace-guide.ts, dev job e3215801 — Antonio 2026-10-28): from the case's LIVE state to the exact next click.
 * The stage data below is the real ITIN pipeline (stage buttons carry their target stage, the upload boxes carry their document type).
 */
import { describe, it, expect } from 'vitest'
import {
  stageDefsFromRows, planGuide, uploadSubStep, ringSelector, guideCardText, guideNotReadyText, parseGuideParam, guideHintFor,
  readGuideOff, writeGuideOff, GUIDE_OFF_KEY, GUIDE_DONE_TEXT, type GuideStageDef, type GuideStep, type StorageLike,
} from '@/lib/flows/workspace-guide'

const adv = (label: string, target: string) => ({ type: 'action_buttons', actions: [{ key: 'advance_next', label, target }] })
const box = (label: string, documentType?: string) => ({ type: 'document_upload', label, ...(documentType ? { documentType } : {}) })
const row = (stage_order: number, stage_name: string, components: unknown[]) => ({ stage_order, stage_name, stage_layout: { components } })

/** the live ITIN pipeline (production, 2026-10-28) */
const ITIN_ROWS = [
  row(1, 'Data Collection', []),
  row(2, 'Document Preparation', [adv('Documents Reviewed — Send to Client', 'Client Signing')]),
  row(3, 'Client Signing', [adv('Documents Received at Office', 'Documents Received')]),
  row(4, 'Shipped', [adv('Documents Received at Office', 'Documents Received')]),
  row(5, 'Documents Received', [box('Upload received package scan', 'itin_application'), adv('Package Complete — Send to CAA Review', 'CAA Review')]),
  row(6, 'CAA Review', [adv('Ready to Submit to IRS', 'Submitted to IRS')]),
  row(7, 'Submitted to IRS', [box('Upload mailing receipt/tracking', 'receipt'), adv('Submitted - Wait for IRS', 'IRS Processing')]),
  row(8, 'IRS Processing', [adv('ITIN Received', 'ITIN Approved')]),
  row(9, 'ITIN Approved', [box('Upload CP565 ITIN Letter', 'itin_letter')]),
]
const STAGES = stageDefsFromRows(ITIN_ROWS)
const LETTER_READY = ['Submitted to IRS', 'IRS Processing', 'ITIN Approved']
const plan = (currentStage: string, documentType = 'itin_letter', status = 'active', readyStages: string[] | null = LETTER_READY) =>
  planGuide({ stages: STAGES, currentStage, status, documentType, readyStages })
const stepsOf = (p: ReturnType<typeof planGuide>) => (p.kind === 'steps' ? p.steps : [])

describe('stageDefsFromRows', () => {
  it('reads each stage\'s forward buttons (with their target) and upload boxes (with their type), in pipeline order', () => {
    const s = stageDefsFromRows([...ITIN_ROWS].reverse())
    expect(s.map((x) => x.name)[0]).toBe('Data Collection')
    const irs = s.find((x) => x.name === 'IRS Processing')!
    expect(irs.actions).toEqual([{ label: 'ITIN Received', target: 'ITIN Approved' }])
    expect(s.find((x) => x.name === 'ITIN Approved')!.boxes).toEqual([{ label: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' }])
  })
  it('ignores what it cannot guide: old fixed action keys, a forward button with no target, junk layouts; an untyped box has no type', () => {
    const s = stageDefsFromRows([
      row(1, 'A', [{ type: 'action_buttons', actions: ['approve', { key: 'advance_next' }, { key: 'advance_next', label: 'Go', target: 'B' }] }, box('Upload X')]),
      { stage_order: 2, stage_name: 'B', stage_layout: 'not a layout' },
      { stage_order: 3, stage_name: 'C', stage_layout: null },
    ])
    expect(s[0].actions).toEqual([{ label: 'Go', target: 'B' }])
    expect(s[0].boxes).toEqual([{ label: 'Upload X', documentType: null }])
    expect(s[1]).toMatchObject({ name: 'B', actions: [], boxes: [] })
    expect(s[2]).toMatchObject({ name: 'C', actions: [], boxes: [] })
  })
})

describe('planGuide — the exact clicks from where the case is now', () => {
  it('the case is AT the stage whose box takes the document -> just the upload step', () => {
    expect(stepsOf(plan('ITIN Approved'))).toEqual([{ kind: 'upload', stage: 'ITIN Approved', boxLabel: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' }])
    expect(stepsOf(plan('Documents Received', 'itin_application', 'active', ['Shipped', 'Documents Received'])).map((s) => s.kind)).toEqual(['upload'])
    expect(stepsOf(plan('Submitted to IRS', 'receipt', 'active', ['Submitted to IRS'])).map((s) => s.kind)).toEqual(['upload'])
  })
  it('ADAM: the letter arrives while the case is at IRS Processing -> press "ITIN Received", then upload', () => {
    const steps = stepsOf(plan('IRS Processing'))
    expect(steps).toEqual([
      { kind: 'press', stage: 'IRS Processing', label: 'ITIN Received', target: 'ITIN Approved' },
      { kind: 'upload', stage: 'ITIN Approved', boxLabel: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' },
    ])
  })
  it('the letter arrives while the case is at "Submitted to IRS" -> two buttons, then upload — and NOT the receipt box that is on screen there', () => {
    const steps = stepsOf(plan('Submitted to IRS'))
    expect(steps.map((s) => (s.kind === 'press' ? `press ${s.label}` : `upload ${s.stage}`))).toEqual(['press Submitted - Wait for IRS', 'press ITIN Received', 'upload ITIN Approved'])
  })
  it('the package scan arrives while the case is at Shipped -> press "Documents Received at Office", then upload', () => {
    const steps = stepsOf(plan('Shipped', 'itin_application', 'active', ['Shipped', 'Documents Received']))
    expect(steps.map((s) => (s.kind === 'press' ? s.label : s.stage))).toEqual(['Documents Received at Office', 'Documents Received'])
  })
  it('after the person presses the button the case is at the next stage and the plan has ONE step fewer (a step finishes only when really done)', () => {
    expect(stepsOf(plan('Submitted to IRS'))).toHaveLength(3)
    expect(stepsOf(plan('IRS Processing'))).toHaveLength(2)
    expect(stepsOf(plan('ITIN Approved'))).toHaveLength(1)
  })
  it('WARN ONLY (Antonio\'s answer 2): a case that is not at a stage where this document is expected gets no guided walk', () => {
    const p = plan('CAA Review')
    expect(p).toEqual({ kind: 'not_ready', currentStage: 'CAA Review', boxStage: 'ITIN Approved', boxLabel: 'Upload CP565 ITIN Letter' })
    expect(plan('Data Collection').kind).toBe('not_ready')
  })
  it('no table of ready stages: a case with no chain of forward buttons to the box is still just a warning, never a guess', () => {
    const lonely: GuideStageDef[] = [
      { name: 'A', order: 1, actions: [], boxes: [] },
      { name: 'B', order: 2, actions: [], boxes: [{ label: 'Upload', documentType: 'x_type' }] },
    ]
    expect(planGuide({ stages: lonely, currentStage: 'A', status: 'active', documentType: 'x_type', readyStages: null }).kind).toBe('not_ready')
  })
  it('a finished case has nothing to guide; a document no box of this service takes is not guided (that workspace is not moved over yet)', () => {
    expect(plan('ITIN Approved', 'itin_letter', 'completed')).toEqual({ kind: 'inactive', reason: 'finished' })
    expect(plan('IRS Processing', 'itin_letter', 'cancelled')).toEqual({ kind: 'inactive', reason: 'finished' })
    expect(plan('IRS Processing', 'tax_return')).toEqual({ kind: 'inactive', reason: 'no_box' })
  })
  it('a loop in the pipeline cannot hang it, and the shortest chain wins', () => {
    const loop: GuideStageDef[] = [
      { name: 'A', order: 1, actions: [{ label: 'to B', target: 'B' }, { label: 'to C', target: 'C' }], boxes: [] },
      { name: 'B', order: 2, actions: [{ label: 'back to A', target: 'A' }, { label: 'to C', target: 'C' }], boxes: [] },
      { name: 'C', order: 3, actions: [{ label: 'back to A', target: 'A' }], boxes: [{ label: 'Upload', documentType: 't' }] },
    ]
    const p = planGuide({ stages: loop, currentStage: 'A', status: 'active', documentType: 't', readyStages: null })
    expect(stepsOf(p).map((s) => (s.kind === 'press' ? s.label : 'upload'))).toEqual(['to C', 'upload'])
  })
  it('an unknown current stage is only a warning', () => {
    expect(plan('Some Old Stage').kind).toBe('not_ready')
  })
})

describe('upload box: which part to circle', () => {
  it('choose the file, then (if the box has a type picker and it is empty) the type, then the upload button', () => {
    expect(uploadSubStep({ fileChosen: false, hasTypePicker: true, typeValue: 'itin_letter' })).toBe('choose')
    expect(uploadSubStep({ fileChosen: true, hasTypePicker: true, typeValue: '' })).toBe('type')
    expect(uploadSubStep({ fileChosen: true, hasTypePicker: true, typeValue: 'itin_letter' })).toBe('submit')
    expect(uploadSubStep({ fileChosen: true, hasTypePicker: false, typeValue: '' })).toBe('submit')
  })
  it('the ring looks for the stage button by its target stage, and for the box (and the part) by its document type', () => {
    expect(ringSelector({ kind: 'press', stage: 'IRS Processing', label: 'ITIN Received', target: 'ITIN Approved' }, 'choose')).toBe('[data-guide-action="ITIN Approved"]')
    const up: GuideStep = { kind: 'upload', stage: 'ITIN Approved', boxLabel: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' }
    expect(ringSelector(up, 'choose')).toBe('[data-guide-box="itin_letter"] [data-guide-part="choose"]')
    expect(ringSelector(up, 'type')).toBe('[data-guide-box="itin_letter"] [data-guide-part="type"]')
    expect(ringSelector(up, 'submit')).toBe('[data-guide-box="itin_letter"] [data-guide-part="submit"]')
  })
  it('a quote or backslash in a stage name can never break out of the selector', () => {
    // the value sits between exactly ONE pair of quotes: a quote or backslash in a stage name is dropped, so it cannot close the value early
    const evil = ringSelector({ kind: 'press', stage: 'A', label: 'x', target: 'B"] , body[x="' }, 'choose')
    expect((evil.match(/"/g) ?? []).length).toBe(2)
    expect(evil.startsWith('[data-guide-action="B')).toBe(true)
    expect(ringSelector({ kind: 'press', stage: 'A', label: 'x', target: 'B\\' }, 'choose')).toBe('[data-guide-action="B"]')
  })
})

describe('the words on the card', () => {
  const asks = 'the IRS approval letter (CP565)'
  const does = ['read the ITIN from the letter and save it on the contact', 'close the case']
  const up: GuideStep = { kind: 'upload', stage: 'ITIN Approved', boxLabel: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' }
  it('a button step names the button, where the case is, where it leads, and what comes next', () => {
    const t = guideCardText({ step: { kind: 'press', stage: 'IRS Processing', label: 'ITIN Received', target: 'ITIN Approved' }, sub: 'choose', asks, does, next: up })
    expect(t.title).toBe('Press "ITIN Received"')
    expect(t.body).toContain('The case is at "IRS Processing"')
    expect(t.body).toContain('moves it to "ITIN Approved"')
    expect(t.body).toContain('upload the IRS approval letter (CP565) in the "Upload CP565 ITIN Letter" box')
  })
  it('an upload step says one thing at a time: choose the file / check the type / press the button (and what the system then does)', () => {
    expect(guideCardText({ step: up, sub: 'choose', asks, does, next: null }).title).toBe('Choose the file')
    expect(guideCardText({ step: up, sub: 'type', asks, does, next: null }).title).toBe('Check the document type')
    const t = guideCardText({ step: up, sub: 'submit', asks, does, next: null })
    expect(t.title).toBe('Press the upload button')
    expect(t.body).toContain('The system will then: read the ITIN from the letter and save it on the contact; close the case.')
  })
  it('the not-ready card says why and that there is nothing to click', () => {
    const t = guideNotReadyText({ kind: 'not_ready', currentStage: 'CAA Review', boxStage: 'ITIN Approved', boxLabel: 'x' }, asks)
    expect(t.body).toContain('The case is at "CAA Review"')
    expect(t.body).toContain('nothing to click')
  })
  it('the end card tells staff to read the message in the box (green = done, yellow = what is missing)', () => {
    expect(GUIDE_DONE_TEXT.body).toContain('yellow warning')
  })
})

describe('the ?guide= value and the table behind it', () => {
  it('only a plain document-type word is accepted', () => {
    expect(parseGuideParam('itin_letter')).toBe('itin_letter')
    expect(parseGuideParam(['receipt', 'x'])).toBe('receipt')
    for (const bad of [undefined, null, '', 'ITIN Letter', 'a-b', '"><script>', 'x'.repeat(61), 5, {}]) expect(parseGuideParam(bad)).toBeNull()
  })
  it('the table gives the words, what the workspace does, and the stages where the document is waiting', () => {
    const h = guideHintFor('ITIN', 'itin_letter')!
    expect(h.asks).toBe('the IRS approval letter (CP565)')
    expect(h.readyStages).toEqual(['Submitted to IRS', 'IRS Processing', 'ITIN Approved'])
    expect(h.does).toContain('close the case')
    expect(guideHintFor('ITIN', 'receipt')!.readyStages).toEqual(['Submitted to IRS'])
    expect(guideHintFor('ITIN', 'itin_application')!.readyStages).toEqual(['Shipped', 'Documents Received'])
    expect(guideHintFor('Tax Return', 'itin_letter')).toBeNull()
    expect(guideHintFor('ITIN', 'passport')).toBeNull()
  })
})

describe('"don\'t guide me again"', () => {
  const mem = (): StorageLike & { data: Record<string, string> } => {
    const data: Record<string, string> = {}
    return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v }, removeItem: (k) => { delete data[k] } }
  }
  it('off once chosen, back on when turned on again', () => {
    const s = mem()
    expect(readGuideOff(s)).toBe(false)
    writeGuideOff(s, true)
    expect(s.data[GUIDE_OFF_KEY]).toBe('1')
    expect(readGuideOff(s)).toBe(true)
    writeGuideOff(s, false)
    expect(readGuideOff(s)).toBe(false)
  })
  it('blocked or missing storage never throws and leaves the guide ON', () => {
    const broken: StorageLike = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    expect(readGuideOff(broken)).toBe(false)
    expect(() => writeGuideOff(broken, true)).not.toThrow()
    expect(readGuideOff(null)).toBe(false)
    expect(() => writeGuideOff(undefined, true)).not.toThrow()
  })
})
