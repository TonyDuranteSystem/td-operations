/**
 * Dev job e3215801 — "make the system flexible instead of hardcoded" (Antonio 2026-10-28). The "a workspace step is waiting for this document"
 * rules are BUILT from the workspaces' own stage layouts (each `document_upload` box + its optional `storageHint`), not written in code.
 * These tests prove (1) the ITIN rules built from the real layouts say exactly what the old hand-written table said (plus "Client Signing"),
 * and (2) a service nobody wrote code for works the moment its upload box is typed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildStepHints, matchStorageStepHints, couldMatchAnyHint, typeCouldWait, typeCouldWaitIn, waitSummary, GENERIC_EFFECT,
  type StorageStepHint,
} from '@/lib/flows/storage-step-rules'
import { parseStageLayout, parseStorageHint } from '@/lib/flows/stage-layout'

type Row = { service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }
const ITIN_ROWS = JSON.parse(readFileSync(join(__dirname, '../fixtures/pipeline-itin-stages.json'), 'utf8')) as Row[]
const HINTS = buildStepHints(ITIN_ROWS)
const kase = (stage: string, serviceType = 'ITIN', status = 'active') => ({ sdId: 'sd-1', serviceType, stage, status, who: 'Adam Mihaly' })
const match = (hints: readonly StorageStepHint[], stage: string, documentType: string | null, folderKind: string | null = 'itin', serviceType = 'ITIN') =>
  matchStorageStepHints({ hints, cases: [kase(stage, serviceType)], documentType, folderKind })

describe('the ITIN rules built from the real layouts = what the old hand-written table said', () => {
  it('three rows, in the pipeline\'s stage order (package, receipt, letter), one per typed upload box', () => {
    expect(HINTS.map((h) => [h.boxStage, h.documentTypes[0]])).toEqual([
      ['Documents Received', 'itin_application'],
      ['Submitted to IRS', 'receipt'],
      ['ITIN Approved', 'itin_letter'],
    ])
    for (const h of HINTS) expect(h.serviceType).toBe('ITIN')
  })

  it('package: same words, same types, same folder, same "Other document" rule — and now also "Client Signing"', () => {
    const h = HINTS[0]
    expect(h.asks).toBe('the signed package received from the client')
    expect(h.documentTypes).toEqual(['itin_application', 'form_w_7'])
    expect(h.folderKind).toBe('itin')
    expect(h.vagueTypes).toEqual(['other_document'])
    expect(h.typeNeedsFolder).toBeUndefined()
    expect(h.stages).toEqual(['Client Signing', 'Shipped', 'Documents Received'])
    expect(h.workspaceDoes.map((e) => e.text)).toEqual(['attach it to the case as the received package', 'move the case on to the CAA review'])
  })

  it('receipt: only inside the ITIN folder (a generic type), only at Submitted to IRS', () => {
    const h = HINTS[1]
    expect(h.asks).toBe('the mailing receipt for the package sent to the IRS')
    expect(h.documentTypes).toEqual(['receipt'])
    expect(h.typeNeedsFolder).toBe(true)
    expect(h.stages).toEqual(['Submitted to IRS'])
    expect(h.workspaceDoes.map((e) => e.text)).toEqual(['attach it to the case as the mailing receipt'])
  })

  it('letter: three letter types, the three stages, the four things the workspace does (the first one Storage ALSO does for "ITIN Letter")', () => {
    const h = HINTS[2]
    expect(h.asks).toBe('the IRS approval letter (CP565)')
    expect(h.documentTypes).toEqual(['itin_letter', 'itin_cp565', 'itin_letter_client_received'])
    expect(h.stages).toEqual(['Submitted to IRS', 'IRS Processing', 'ITIN Approved'])
    expect(h.workspaceDoes.map((e) => e.text)).toEqual([
      'read the ITIN from the letter and save it on the contact',
      'show the letter to the client',
      'tell the client in the portal (a message and a notification; an email only if they do not have the app)',
      'close the case',
    ])
    expect(h.workspaceDoes[0].key).toBe('read_itin')
  })

  it('"Client Signing" (4 of 9 real open cases sit there): the package scan raises the pop-up, the letter still does not', () => {
    const pkg = match(HINTS, 'Client Signing', 'itin_application')
    expect(pkg).toHaveLength(1)
    expect(pkg[0].how).toBe('Press "Documents Received at Office" first, then upload it in the "Upload received package scan" box.')
    expect(match(HINTS, 'Client Signing', 'itin_letter')).toHaveLength(0)
  })

  it('the exact next click is WORKED OUT from the stage buttons (the guide\'s own path-finder), per stage', () => {
    const how = (stage: string, type: string) => match(HINTS, stage, type)[0].how
    expect(how('Shipped', 'itin_application')).toBe('Press "Documents Received at Office" first, then upload it in the "Upload received package scan" box.')
    expect(how('Documents Received', 'itin_application')).toBe('Upload it in the "Upload received package scan" box.')
    expect(how('IRS Processing', 'itin_letter')).toBe('Press "ITIN Received" first, then upload it in the "Upload CP565 ITIN Letter" box.')
    expect(how('ITIN Approved', 'itin_letter')).toBe('Upload it in the "Upload CP565 ITIN Letter" box.')
    // at Submitted to IRS the case has a DIFFERENT upload box (the receipt): the letter must not go there
    expect(how('Submitted to IRS', 'itin_letter')).toBe(
      'Press "Submitted - Wait for IRS", then "ITIN Received", then upload it in the "Upload CP565 ITIN Letter" box. Do not use the "Upload mailing receipt/tracking" box you see now — it is for a different document.',
    )
    expect(how('Submitted to IRS', 'receipt')).toBe('Upload it in the "Upload mailing receipt/tracking" box.')
  })

  it('what Storage itself does is told from CODE keyed by the effect (not by matching sentences): only "ITIN Letter" is read by Storage', () => {
    const letter = match(HINTS, 'IRS Processing', 'itin_letter')[0]
    expect(letter.storageDoes).toEqual(['try to read the ITIN number off the letter and save it on the contact'])
    expect(letter.workspaceDoes).not.toContain('read the ITIN from the letter and save it on the contact')
    const cp565 = match(HINTS, 'IRS Processing', 'itin_cp565')[0]
    expect(cp565.storageDoes).toEqual([])
    expect(cp565.workspaceDoes).toContain('read the ITIN from the letter and save it on the contact')
  })

  it('the guide link is about the box\'s own document type', () => {
    expect(match(HINTS, 'IRS Processing', 'itin_letter_client_received')[0].workspacePath).toBe('/flows/sd-1?guide=itin_letter')
    expect(match(HINTS, 'Client Signing', 'form_w_7')[0].workspacePath).toBe('/flows/sd-1?guide=itin_application')
  })
})

// ── a service nobody wrote code for ───────────────────────────────────────────────────────────────────────────────────────────

const stage = (service: string, name: string, order: number, components: unknown[]): Row => ({ service_type: service, stage_name: name, stage_order: order, stage_layout: { components } })
const btn = (label: string, target: string) => ({ type: 'action_buttons', actions: [{ key: 'advance_next', label, target }] })

const NEW_SERVICE: Row[] = [
  stage('Trademark', 'Intake', 1, [btn('Start filing', 'Filing')]),
  stage('Trademark', 'Filing', 2, [{ type: 'document_upload', label: 'Upload the filing receipt', documentType: 'tm_receipt' }, btn('Filed', 'Registered')]),
  stage('Trademark', 'Registered', 3, [{ type: 'document_upload', label: 'Upload the certificate', documentType: 'tm_certificate', storageHint: { asks: 'the registration certificate', fromStages: ['Filing', 'Registered'], effects: ['tell the client', { text: 'close the case', key: 'x' }] } }]),
]

describe('flexible: a NEW service is covered the moment its upload box is typed (data only, no code)', () => {
  const hints = buildStepHints(NEW_SERVICE)
  it('a box with only a documentType fires at its own stage, with the box label as the words and ONLY the always-true effect line', () => {
    const r = match(hints, 'Filing', 'tm_receipt', null, 'Trademark')
    expect(r).toHaveLength(1)
    expect(r[0].asks).toBe('the document for the "Upload the filing receipt" box')
    expect(r[0].how).toBe('Upload it in the "Upload the filing receipt" box.')
    expect(r[0].workspaceDoes).toEqual([GENERIC_EFFECT])
    expect(r[0].storageDoes).toEqual([])
    expect(r[0].workspacePath).toBe('/flows/sd-1?guide=tm_receipt')
    // nowhere else, because nothing widened it
    expect(match(hints, 'Intake', 'tm_receipt', null, 'Trademark')).toHaveLength(0)
    expect(match(hints, 'Registered', 'tm_receipt', null, 'Trademark')).toHaveLength(0)
  })

  it('a storageHint widens the stages, says the words, and the pop-up tells the buttons to press from an earlier stage', () => {
    const r = match(hints, 'Filing', 'tm_certificate', null, 'Trademark')
    expect(r).toHaveLength(1)
    expect(r[0].asks).toBe('the registration certificate')
    expect(r[0].how).toBe('Press "Filed" first, then upload it in the "Upload the certificate" box. Do not use the "Upload the filing receipt" box you see now — it is for a different document.')
    expect(r[0].workspaceDoes).toEqual(['tell the client', 'close the case'])
    expect(match(hints, 'Registered', 'tm_certificate', null, 'Trademark')[0].how).toBe('Upload it in the "Upload the certificate" box.')
  })

  it('another service\'s cases never match (the rules are per service)', () => {
    expect(match(hints, 'Filing', 'tm_receipt', null, 'ITIN')).toHaveLength(0)
    expect(match([...HINTS, ...hints], 'Filing', 'itin_letter', 'itin', 'Trademark')).toHaveLength(0)
  })

  it('a box with NO documentType is never matched (there is nothing to match it with)', () => {
    const untyped = buildStepHints([stage('X', 'A', 1, [{ type: 'document_upload', label: 'Upload it', storageHint: { asks: 'something' } }])])
    expect(untyped).toEqual([])
  })

  it('a stage named in fromStages that the pipeline does not have is dropped, and the box\'s own stage is always kept', () => {
    const h = buildStepHints([
      stage('X', 'A', 1, [btn('Go', 'B')]),
      stage('X', 'B', 2, [{ type: 'document_upload', label: 'Up', documentType: 't', storageHint: { fromStages: ['A', 'Typo Stage'] } }]),
    ])[0]
    expect(h.stages).toEqual(['A', 'B'])
    expect(h.howByStage['A']).toBe('Press "Go" first, then upload it in the "Up" box.')
  })

  it('no chain of guided buttons reaches the box: it says so instead of guessing', () => {
    const h = buildStepHints([
      stage('X', 'A', 1, [{ type: 'chat' }]),
      stage('X', 'B', 2, [{ type: 'document_upload', label: 'Up', documentType: 't', storageHint: { fromStages: ['A'] } }]),
    ])[0]
    expect(h.howByStage['A']).toBe('Move the case to "B" first, then upload it in the "Up" box.')
  })

  it('two services in one rules list: the first matching row wins inside a service, in stage order', () => {
    const h = buildStepHints([
      stage('X', 'Late', 9, [{ type: 'document_upload', label: 'Late box', documentType: 'late', storageHint: { folderKind: 'k', otherDocumentCounts: true, fromStages: ['Early', 'Late'] } }]),
      stage('X', 'Early', 1, [{ type: 'document_upload', label: 'Early box', documentType: 'early', storageHint: { folderKind: 'k', otherDocumentCounts: true } }]),
    ])
    expect(h.map((x) => x.boxStage)).toEqual(['Early', 'Late'])
    // a vague file ("Other document" in folder kind k) at Early is the EARLY box's
    expect(match(h, 'Early', 'other_document', 'k', 'X')[0].asks).toContain('Early box')
  })
})

// ── what the browser asks ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the list the browser uses to skip the check for an ordinary file', () => {
  it('comes from the layouts: every type any box takes, and the "Other document" rule', () => {
    const s = waitSummary(HINTS)
    for (const t of ['itin_application', 'form_w_7', 'receipt', 'itin_letter', 'itin_cp565', 'itin_letter_client_received']) expect(s.types, t).toContain(t)
    expect(s.vagueTypes).toEqual(['other_document'])
    expect(waitSummary(buildStepHints(NEW_SERVICE)).types).toEqual(['tm_receipt', 'tm_certificate'])
  })
  it('an ordinary type is skipped; a workspace type, "Other document" and no type are checked', () => {
    expect(typeCouldWait(HINTS, 'passport')).toBe(false)
    expect(typeCouldWait(HINTS, 'ein_letter_irs')).toBe(false)
    expect(typeCouldWait(HINTS, 'itin_letter')).toBe(true)
    expect(typeCouldWait(HINTS, 'other_document')).toBe(true)
    expect(typeCouldWait(HINTS, null)).toBe(true)
    expect(typeCouldWait([], null)).toBe(false)   // no workspace takes any document: nothing can wait
  })
  it('a list that could not be loaded means CHECK EVERYTHING, never "check nothing"', () => {
    expect(typeCouldWaitIn(null, 'passport')).toBe(true)
    expect(typeCouldWaitIn(null, null)).toBe(true)
  })
  it('couldMatchAnyHint: a generic type counts only in the folder kind the box names', () => {
    expect(couldMatchAnyHint(HINTS, 'receipt', 'itin')).toBe(true)
    expect(couldMatchAnyHint(HINTS, 'receipt', 'personal')).toBe(false)
    expect(couldMatchAnyHint(HINTS, 'other_document', 'personal')).toBe(false)
    expect(couldMatchAnyHint(HINTS, 'passport', 'itin')).toBe(false)
  })
})

// ── the layout parts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('storageHint in a stage layout is read carefully (anything unusable is dropped, never thrown)', () => {
  it('reads the fields it knows, with effects as sentences or {text, key}', () => {
    expect(parseStorageHint({ asks: 'a', acceptsTypes: ['x', 2, ''], folderKind: 'itin', typeNeedsFolder: true, otherDocumentCounts: false, fromStages: ['S'], effects: ['one', { text: 'two', key: 'k' }, { nope: 1 }, 5] })).toEqual({
      asks: 'a', acceptsTypes: ['x'], folderKind: 'itin', typeNeedsFolder: true, otherDocumentCounts: false, fromStages: ['S'], effects: [{ text: 'one' }, { text: 'two', key: 'k' }],
    })
  })
  it('garbage becomes "no hint"', () => {
    for (const v of [null, undefined, 5, 'x', [], {}, { effects: [] }, { asks: '  ' }]) expect(parseStorageHint(v), JSON.stringify(v)).toBeUndefined()
  })
  it('a layout carries the hint on its upload box', () => {
    const l = parseStageLayout({ components: [{ type: 'document_upload', label: 'L', documentType: 't', storageHint: { asks: 'x' } }] })
    expect(l?.components[0].storageHint).toEqual({ asks: 'x' })
  })
})
