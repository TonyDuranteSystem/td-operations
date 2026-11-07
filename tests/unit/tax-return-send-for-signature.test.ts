/**
 * Tax Return plan, Part 2 item 5 (dev job 6f555c9f) — the prepared return is sent for signature FROM THE WORKSPACE, and the job moves by itself:
 * to "Sent for Signature" when staff send the document, to "Signed" when the client signs (the move rules are tested in esign-delivery-advance.test.ts).
 * Two new steps of the Tax Return pipeline, the e-sign panel on "Preparation", the fax + File with IRS on "Signed" — by DATA
 * (scripts/migrations/20261106-2330-…), read here from the layouts dumped from the sandbox AFTER the data change
 * (tests/fixtures/pipeline-tax-return-stages.json).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseStageLayout } from '@/lib/flows/stage-layout'
import { buildStepHints, stepHintProblems } from '@/lib/flows/storage-step-rules'
import { esignDocName } from '@/lib/flows/esign-doc-name'
import { protectedStageReason } from '@/lib/services/protected-stage-names'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'
import { flowStageBannerState } from '@/lib/tax/flow-banner'

type Row = { service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const ROWS = JSON.parse(read('../fixtures/pipeline-tax-return-stages.json')) as Row[]
const layoutOf = (stage: string) => parseStageLayout(ROWS.find((r) => r.stage_name === stage)!.stage_layout)!
const orderOf = (stage: string) => ROWS.find((r) => r.stage_name === stage)!.stage_order
const up = read('../../scripts/migrations/20261106-2330-tax-return-send-for-signature-steps.sql')
const undo = read('../../scripts/migrations/20261106-2330-tax-return-send-for-signature-steps.UNDO.sql')

describe('the Tax Return pipeline after the data change', () => {
  it('the new steps sit in the right order and no two steps share an order', () => {
    expect(orderOf('Preparation')).toBeLessThan(orderOf('Sent for Signature'))
    expect(orderOf('Sent for Signature')).toBeLessThan(orderOf('Signed'))
    expect(orderOf('Signed')).toBeLessThan(orderOf('TR Filed'))
    const orders = ROWS.map((r) => r.stage_order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('the names in the code are the names in the pipeline', () => {
    for (const name of Object.values(TAX_RETURN_SIGN_STAGES)) expect(ROWS.some((r) => r.stage_name === name), name).toBe(true)
  })

  it('every button of every Tax Return step goes to a step that really exists', () => {
    const names = new Set(ROWS.map((r) => r.stage_name))
    for (const r of ROWS) {
      for (const c of parseStageLayout(r.stage_layout)?.components ?? []) {
        for (const a of c.actions ?? []) {
          if (typeof a === 'object' && a.target) expect(names.has(a.target), `${r.stage_name} → ${a.target}`).toBe(true)
        }
      }
    }
  })
})

describe('the three steps of the signing journey', () => {
  it('"Preparation": the file is uploaded, THEN the e-sign panel sends it; the panel is worded for the return and names the document by year and company', () => {
    const comps = layoutOf('Preparation').components
    const panel = comps.find((c) => c.type === 'esign_panel')!
    expect(panel).toMatchObject({ title: 'Return for the client to sign', label: 'Send the return for signature', rename: 'Tax Return {year} - {company_name}' })
    expect(panel.helpText).toMatch(/moves to Sent for Signature when you send it, and to Signed when the client signs/)
    expect(panel.helpText).toMatch(/Nothing is faxed or filed automatically/)
  })

  it('"Sent for Signature": the client has it. The panel offers to send again (a cancelled or expired document), and one button covers a return signed outside the system — asking first', () => {
    const comps = layoutOf('Sent for Signature').components
    expect(comps.map((c) => c.type)).toEqual(['waiting_notice', 'esign_panel', 'document_viewer', 'action_buttons', 'chat'])
    const panel = comps.find((c) => c.type === 'esign_panel')!
    expect(panel.label).toBe('Send the return again')
    expect(panel.readOnly).toBeUndefined()
    const [b] = comps.find((c) => c.type === 'action_buttons')!.actions! as Array<{ key: string; target: string; confirm: string }>
    expect(b).toMatchObject({ key: 'advance_next', target: 'Signed' })
    expect(b.confirm).toMatch(/only if the client signed outside the system/)
  })

  it('"Signed": status-only panel (no second document to prepare), the fax panel and File with IRS — which asks first and goes to TR Filed', () => {
    const comps = layoutOf('Signed').components
    expect(comps.map((c) => c.type)).toEqual(['esign_panel', 'document_viewer', 'action_buttons', 'fax_irs', 'chat'])
    expect(comps.find((c) => c.type === 'esign_panel')!.readOnly).toBe(true)
    const [b] = comps.find((c) => c.type === 'action_buttons')!.actions! as Array<{ key: string; target: string; confirm: string }>
    expect(b).toMatchObject({ key: 'file_with_irs', target: 'TR Filed' })
    expect(b.confirm).toMatch(/filed with the IRS/)
  })

  it('the older "TR Completed" step keeps its layout (fax + File with IRS) for old jobs and manual moves', () => {
    expect(layoutOf('TR Completed').components.map((c) => c.type)).toEqual(['document_viewer', 'action_buttons', 'fax_irs', 'chat'])
  })

  it('nothing is faxed or filed by itself: no step in the journey advances without a human press except the two e-sign moves', () => {
    for (const stage of ['Preparation', 'Sent for Signature', 'Signed']) {
      expect(layoutOf(stage).components.some((c) => c.type === 'document_upload' && c.autoAdvance !== false && stage !== 'Preparation'), stage).toBe(false)
    }
    const preparationBox = layoutOf('Preparation').components.find((c) => c.type === 'document_upload')!
    expect(preparationBox.autoAdvance).toBe(false)
  })
})

describe('the layout engine and the panel name', () => {
  it('title, readOnly, helpText and rename survive the layout reader for an e-sign panel; a non-boolean readOnly is dropped', () => {
    const l = parseStageLayout({ components: [{ type: 'esign_panel', title: 'T', helpText: 'H', rename: 'Tax Return {year} - {company_name}', readOnly: true }, { type: 'esign_panel', readOnly: 'yes' }] })!
    expect(l.components[0]).toMatchObject({ title: 'T', helpText: 'H', rename: 'Tax Return {year} - {company_name}', readOnly: true })
    expect(l.components[1].readOnly).toBeUndefined()
    expect(l.components[1].title).toBeUndefined()
  })

  it('esignDocName fills company and year; a missing token is dropped, never printed', () => {
    expect(esignDocName('Tax Return {year} - {company_name}', { company_name: 'Beta LLC', year: 2025 })).toBe('Tax Return 2025 - Beta LLC')
    expect(esignDocName('Tax Return {year} - {company_name}', { company_name: 'Beta LLC', year: null })).toBe('Tax Return - Beta LLC')
    expect(esignDocName('Tax Return {year} - {company_name}', { company_name: null, year: 2025 })).toBe('Tax Return 2025')
    expect(esignDocName('Tax Return {year} - {company_name}', { company_name: '  Beta   LLC ', year: '2025' })).toBe('Tax Return 2025 - Beta LLC')
    expect(esignDocName(undefined, { company_name: 'Beta LLC', year: 2025 })).toBeUndefined()
    expect(esignDocName('   ', { company_name: 'Beta LLC', year: 2025 })).toBeUndefined()
    expect(esignDocName('{company_name}', { company_name: '', year: 2025 })).toBeUndefined()
  })

  it('the panel keeps its Company Change Name wording when the layout sets none, and the workspace passes the year', () => {
    const panel = read('../../components/flows/esign-panel.tsx')
    expect(panel).toContain("title || 'Form for the client to sign'")
    expect(panel).toContain('Company name change form —')
    expect(panel).toContain('{!readOnly && (')
    const renderer = read('../../components/flows/stage-renderer.tsx')
    expect(renderer).toContain('esignDocName(component.rename, { company_name: account.company_name, year: flowYear })')
    expect(read('../../app/(dashboard)/flows/[id]/page.tsx')).toContain('flowYear={year}')
  })
})

describe('the storage rule and the client banner follow the new steps', () => {
  it('the pop-up rule is unchanged: still one box (Preparation), the same types and stages', () => {
    const hints = buildStepHints(ROWS)
    expect(hints.map((h) => [h.boxStage, h.documentTypes[0], h.stages])).toEqual([['Preparation', 'tax_return', ['Data Received', 'Preparation']]])
    expect(stepHintProblems(ROWS)).toEqual([])
  })

  it('the three step names the code matches are protected from a rename in the catalog editor', () => {
    for (const name of ['Preparation', 'Sent for Signature', 'Signed', 'TR Completed']) expect(protectedStageReason(name), name).toBeTruthy()
  })

  it('the client banner: Sent for Signature → sign, Signed → signed, the older TR Completed → being prepared', () => {
    expect(flowStageBannerState('Sent for Signature')).toBe('sign')
    expect(flowStageBannerState('Signed')).toBe('signed')
    expect(flowStageBannerState('TR Completed')).toBe('preparing')
  })

  it('"Sent for Signature" is mapped to the tax record status "TR Completed - Awaiting Signature"; "Signed" deliberately is not (there is no signed status)', () => {
    const src = read('../../lib/service-delivery.ts')
    expect(src).toContain('"Sent for Signature": "TR Completed - Awaiting Signature"')
    expect(src).not.toContain('"Signed": "')
  })
})

describe('the data change (migration + undo)', () => {
  const blocks = up.split('INSERT INTO pipeline_stages').slice(1)

  it('two guarded INSERTs, one per new step: they copy the Preparation row (so the catalog link is the same in every environment) and fire only while the step does not exist', () => {
    expect(blocks).toHaveLength(2)
    for (const b of blocks) {
      expect(b).toContain("WHERE p.service_type = 'Tax Return' AND p.stage_name = 'Preparation'")
      expect(b).toContain('AND NOT EXISTS (SELECT 1 FROM pipeline_stages x WHERE x.service_type = \'Tax Return\' AND x.stage_name =')
      expect(b).toContain('p.service_type_entry_id')
    }
  })

  it('the new steps carry the right order, client words (English and Italian) and who the job waits on', () => {
    const [sent, signed] = blocks
    expect(sent).toContain("SELECT p.service_type, 65, 'Sent for Signature'")
    expect(sent).toContain("'Ready to Sign', 'Pronto per la Firma'")
    expect(sent).toContain("'client', false, false")
    expect(signed).toContain("SELECT p.service_type, 68, 'Signed'")
    expect(signed).toContain("'Signed', 'Firmata'")
    expect(signed).toContain("'us', false, false")
    // neither new step is the "done" step (the database allows one per service) and neither creates tasks or messages
    for (const b of blocks) {
      expect(b).toContain("'[]'::jsonb, '[]'::jsonb")
      expect(b).toMatch(/false, false, false, '(client|us)', false, false/)
    }
  })

  it('the layouts the INSERTs write are exactly the dumped ones', () => {
    for (const b of blocks) {
      const name = /SELECT p\.service_type, \d+, '([^']+)'/.exec(b)![1]
      const json = /'(\{"components": [\s\S]*?\})'::jsonb/.exec(b)![1].replace(/''/g, "'")
      expect(ROWS.find((r) => r.stage_name === name)!.stage_layout).toEqual(JSON.parse(json))
    }
  })

  it('the old "Ready to Sign" label leaves "TR Completed" (the progress bar shows one), guarded on the exact old words; "Preparation" is updated only from the item-4 layout', () => {
    expect(up).toContain("SET client_label = NULL, client_label_it = NULL")
    expect(up).toContain("AND client_label = 'Ready to Sign' AND client_label_it = 'Pronto per la Firma'")
    expect(up.match(/AND stage_layout = /g)).toHaveLength(1)
  })

  it('the undo removes the new steps only while NO job sits on them, and restores the item-4 layout and the old label', () => {
    expect(undo).toContain("AND NOT EXISTS (SELECT 1 FROM service_deliveries sd WHERE sd.service_type = 'Tax Return' AND sd.stage IN ('Sent for Signature', 'Signed'))")
    expect(undo).toContain('"Return ready — mark Ready to Sign"')
    expect(undo).toContain("SET client_label = 'Ready to Sign', client_label_it = 'Pronto per la Firma'")
    expect(undo.match(/AND stage_layout = /g)).toHaveLength(1)
  })
})
