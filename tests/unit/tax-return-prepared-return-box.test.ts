/**
 * Tax Return plan, Part 2 item 4 (dev job 6f555c9f) — the "Upload Prepared Tax Return" box moves to the step where the return is really prepared
 * ("Preparation") and joins the Storage model: a TYPED box (Antonio 2026-10-28: a workspace upload follows the Storage rule), internal (the unsigned
 * return is never shown to the client), joined to the "a workspace step is waiting for this document" pop-up and the guide — by DATA only
 * (scripts/migrations/20261106-2300-…). The layouts are dumped from the sandbox AFTER the data change (tests/fixtures/pipeline-tax-return-stages.json),
 * and a test below proves the dump equals what the migration writes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildStepHints, matchStorageStepHints, stepHintProblems } from '@/lib/flows/storage-step-rules'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { isClientSafeFlowDoc } from '@/lib/flows/flow-doc-visibility'

type Row = { service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const TAX_ROWS = JSON.parse(read('../fixtures/pipeline-tax-return-stages.json')) as Row[]
const ITIN_ROWS = JSON.parse(read('../fixtures/pipeline-itin-stages.json')) as Row[]
const FORMATION_ROWS = JSON.parse(read('../fixtures/pipeline-formation-stages.json')) as Row[]
const CN_ROWS = JSON.parse(read('../fixtures/pipeline-change-name-stages.json')) as Row[]
const HINTS = buildStepHints(TAX_ROWS)
const SERVICE = 'Tax Return'
const layoutOf = (stage: string) => parseStageLayout(TAX_ROWS.find((r) => r.stage_name === stage)!.stage_layout)!
const kase = (stage: string, status = 'active') => ({ sdId: 'sd-1', serviceType: SERVICE, stage, status, who: 'Beta LLC' })
const match = (stage: string, documentType: string | null, folderKind: string | null = 'tax_year') =>
  matchStorageStepHints({ hints: HINTS, cases: [kase(stage)], documentType, folderKind })

describe('the Tax Return layouts', () => {
  it('"Data Received" no longer takes the prepared return: a Start Preparation button moves the job on', () => {
    const l = layoutOf('Data Received')
    expect(l.components.some((c) => c.type === 'document_upload')).toBe(false)
    const buttons = l.components.find((c) => c.type === 'action_buttons')!.actions!
    expect(buttons).toEqual([{ key: 'advance_next', label: 'Start Preparation', target: 'Preparation' }])
  })

  it('"Preparation" has ONE upload box: typed "tax_return", filed in the Tax folder, and it does NOT move the job', () => {
    const boxes = layoutOf('Preparation').components.filter((c) => c.type === 'document_upload')
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ label: 'Upload Prepared Tax Return', folder: '3. Tax', autoAdvance: false, documentType: 'tax_return' })
  })

  it('"Return ready" is its own button, goes to the real next step, and asks first (the client is told "Ready to Sign")', () => {
    const [b] = layoutOf('Preparation').components.find((c) => c.type === 'action_buttons')!.actions! as Array<{ key: string; label: string; target: string; confirm: string }>
    expect(b.key).toBe('advance_next')
    expect(b.target).toBe('TR Completed')
    expect(TAX_ROWS.some((r) => r.stage_name === b.target)).toBe(true)
    expect(b.confirm).toMatch(/send it for signature first/)
  })

  it('the preparer sees the client\'s answers on this step too', () => {
    expect(layoutOf('Preparation').components.some((c) => c.type === 'data_viewer')).toBe(true)
  })

  it('the other upload boxes of the service are untouched and stay untyped (extension receipt, client data)', () => {
    for (const [stage, label] of [['1st Installment Paid', 'Upload Extension Receipt'], ['Wizard Available', 'Upload Client Data']] as const) {
      const box = layoutOf(stage).components.find((c) => c.type === 'document_upload')!
      expect(box.label).toBe(label)
      expect(box.documentType).toBeUndefined()
    }
  })
})

describe('the rule built from the real layouts', () => {
  it('exactly one row: the "Upload Prepared Tax Return" box; it takes the Tax return type and the other return types', () => {
    expect(HINTS.map((h) => [h.serviceType, h.boxStage, h.boxLabel])).toEqual([[SERVICE, 'Preparation', 'Upload Prepared Tax Return']])
    expect(HINTS[0].documentTypes).toEqual(['tax_return', 'form_1120', 'form_5472', 'form_1120_5472', 'form_1065', 'form_1120c'])
    expect(HINTS[0].stages).toEqual(['Data Received', 'Preparation'])
  })

  it('the words and what the workspace does (staff-facing wording, shown to Antonio before production)', () => {
    const [h] = HINTS
    expect(h.asks).toBe('the prepared tax return (not yet signed)')
    expect(h.workspaceDoes.map((e) => e.text)).toEqual([
      "save the file on the case, in the company's Tax folder",
      'keep it hidden from the client (the unsigned return is never shown)',
    ])
  })

  it('the settings checker finds nothing wrong, alone or next to the other services', () => {
    expect(stepHintProblems(TAX_ROWS)).toEqual([])
    expect(stepHintProblems([...ITIN_ROWS, ...FORMATION_ROWS, ...CN_ROWS, ...TAX_ROWS])).toEqual([])
  })

  it('the other services\' rules are unchanged by adding this one', () => {
    const all = buildStepHints([...ITIN_ROWS, ...FORMATION_ROWS, ...CN_ROWS, ...TAX_ROWS])
    expect(all.filter((h) => h.serviceType !== SERVICE)).toEqual(buildStepHints([...ITIN_ROWS, ...FORMATION_ROWS, ...CN_ROWS]))
  })
})

describe('when a prepared return raises the pop-up', () => {
  it('a return-type file saved to Storage while the case is at "Data Received" or "Preparation": told how to do it in the workspace', () => {
    for (const t of ['tax_return', 'form_1120', 'form_5472', 'form_1120_5472', 'form_1065', 'form_1120c']) {
      expect(match('Preparation', t), t).toHaveLength(1)
      expect(match('Data Received', t), t).toHaveLength(1)
    }
    expect(match('Preparation', 'tax_return')[0].how).toBe('Upload it in the "Upload Prepared Tax Return" box.')
    expect(match('Data Received', 'tax_return')[0].how).toBe('Press "Start Preparation" first, then upload it in the "Upload Prepared Tax Return" box.')
  })

  it('NOT at any other step: a filed or signed return saved later, or a return saved while the client is still at the wizard, raises nothing', () => {
    for (const s of ['Wizard Available', 'Data Submitted', 'Under Review', 'Revision Requested', 'Approved', 'TR Completed', 'TR Filed', 'Extension Filed']) {
      expect(match(s, 'tax_return'), s).toHaveLength(0)
    }
  })

  it('NOT for other document types (IRS proofs, passports, an untyped file)', () => {
    for (const t of ['fax_confirmation', 'irs_e_file_acknowledgment', 'passport', 'ein_letter_irs', 'other_document', 'forms_1120_5472_irs_receipt']) {
      expect(match('Preparation', t), t).toHaveLength(0)
    }
    expect(match('Preparation', null)).toHaveLength(0)
  })

  it('a finished or cancelled case raises nothing', () => {
    for (const status of ['completed', 'cancelled']) {
      expect(matchStorageStepHints({ hints: HINTS, cases: [kase('Preparation', status)], documentType: 'tax_return', folderKind: 'tax_year' })).toHaveLength(0)
    }
  })
})

describe('the unsigned return stays internal', () => {
  it('a file uploaded at "Data Received" or "Preparation" is not on the client-visible list', () => {
    for (const stage of ['Data Received', 'Preparation']) expect(isClientSafeFlowDoc(SERVICE, stage, false), stage).toBe(false)
  })
})

describe('the data change (migration + undo)', () => {
  const up = read('../../scripts/migrations/20261106-2300-tax-return-prepared-return-box-at-preparation.sql')
  const undo = read('../../scripts/migrations/20261106-2300-tax-return-prepared-return-box-at-preparation.UNDO.sql')

  it('the dumped layouts are exactly what the migration writes', () => {
    const re = /SET stage_layout = '(.*?)'::jsonb\s*\nWHERE service_type = 'Tax Return' AND stage_name = '([^']+)'/gs
    const written: Record<string, unknown> = {}
    for (const m of Array.from(up.matchAll(re))) written[m[2]] = JSON.parse(m[1].replace(/''/g, "'"))
    expect(Object.keys(written).sort()).toEqual(['Data Received', 'Preparation'])
    for (const stage of Object.keys(written)) expect(TAX_ROWS.find((r) => r.stage_name === stage)!.stage_layout).toEqual(written[stage])
  })

  it('every UPDATE only fires on the exact old row (layouts: the whole old layout; label: the exact old words)', () => {
    expect(up.match(/AND stage_layout = /g)).toHaveLength(2)
    expect(up).toContain("AND client_label = 'With Accountant' AND client_label_it = 'Dal Commercialista'")
    expect(up).toContain("SET client_label = 'Being prepared', client_label_it = 'In preparazione'")
  })

  it('the undo restores the old layouts and the old label, and only fires on the new ones', () => {
    expect(existsSync(join(__dirname, '../../scripts/migrations/20261106-2300-tax-return-prepared-return-box-at-preparation.UNDO.sql'))).toBe(true)
    expect(undo.match(/AND stage_layout = /g)).toHaveLength(2)
    expect(undo).toContain("SET client_label = 'With Accountant', client_label_it = 'Dal Commercialista'")
    expect(undo).toContain('"Upload Prepared Tax Return"}, {"type": "document_viewer"}, {"type": "chat"}], "description": "Data received. Prepare the tax return."')
  })
})
