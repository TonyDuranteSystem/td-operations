/**
 * Dev job e3215801 — the Company Formation workspace joins the "a workspace step is waiting for this document" pop-up and the guide, by DATA only:
 * its three upload boxes (Articles / fax confirmation / EIN letter) carry a `documentType` + `storageHint` (scripts/migrations/20261029-0200-…).
 * Antonio approved the wording 2026-10-29. The layouts are dumped from the sandbox AFTER the data change (tests/fixtures/pipeline-formation-stages.json).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStepHints, matchStorageStepHints, stepHintProblems, typeCouldWait, type StorageStepHint } from '@/lib/flows/storage-step-rules'

type Row = { service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }
const FORMATION_ROWS = JSON.parse(readFileSync(join(__dirname, '../fixtures/pipeline-formation-stages.json'), 'utf8')) as Row[]
const ITIN_ROWS = JSON.parse(readFileSync(join(__dirname, '../fixtures/pipeline-itin-stages.json'), 'utf8')) as Row[]
const HINTS = buildStepHints(FORMATION_ROWS)
const BOTH = buildStepHints([...ITIN_ROWS, ...FORMATION_ROWS])
const SERVICE = 'Company Formation'
const kase = (stage: string, serviceType = SERVICE, status = 'active') => ({ sdId: 'sd-1', serviceType, stage, status, who: 'Beta LLC' })
const match = (hints: readonly StorageStepHint[], stage: string, documentType: string | null, folderKind: string | null = 'company', serviceType = SERVICE) =>
  matchStorageStepHints({ hints, cases: [kase(stage, serviceType)], documentType, folderKind })

const ALL_STAGES = ['Payment Confirmed', 'Wizard Submitted', 'Filed with State', 'Articles Received', 'SS-4 Prepared', 'SS-4 Signed', 'SS-4 Sent to IRS', 'EIN Received']

describe('the Company Formation rules built from the real layouts', () => {
  it('three rows, in the pipeline order (Articles, fax confirmation, EIN letter), one per typed upload box', () => {
    expect(HINTS.map((h) => [h.boxStage, h.documentTypes])).toEqual([
      ['Filed with State', ['articles_of_organization']],
      ['SS-4 Signed', ['fax_confirmation']],
      ['EIN Received', ['ein_letter_irs']],
    ])
    for (const h of HINTS) expect(h.serviceType).toBe(SERVICE)
  })

  it('the words and what the workspace does (the sentences Antonio approved, 2026-10-29)', () => {
    const [articles, fax, ein] = HINTS
    expect(articles.asks).toBe('the Articles of Organization from the state')
    expect(articles.workspaceDoes.map((e) => e.text)).toEqual([
      "ask for the company's legal name, state, LLC type and formation date",
      'save the file on the case',
      'move the case on to Articles Received and create the company',
    ])
    expect(fax.asks).toBe('the fax confirmation for the SS-4 sent to the IRS')
    expect(fax.workspaceDoes.map((e) => e.text)).toEqual(['save the file on the case', 'move the case on to SS-4 Sent to IRS'])
    expect(ein.asks).toBe('the IRS EIN letter (CP 575)')
    expect(ein.workspaceDoes.map((e) => e.text)).toEqual([
      'rename it "EIN Official – company name" and file it in the "1. Company" folder',
      'save the file on the case',
    ])
  })

  it('nothing in these boxes needs a folder kind: no "Other document" rule, no generic type', () => {
    for (const h of HINTS) {
      expect(h.folderKind).toBeUndefined()
      expect(h.vagueTypes).toBeUndefined()
      expect(h.typeNeedsFolder).toBeUndefined()
    }
  })

  it('the settings checker finds nothing wrong with the real Formation layouts', () => {
    expect(stepHintProblems(FORMATION_ROWS)).toEqual([])
    expect(stepHintProblems([...ITIN_ROWS, ...FORMATION_ROWS])).toEqual([])
  })
})

describe('when each Formation document raises the pop-up', () => {
  it('Articles: only while the case is at "Filed with State" (that is when the state sends them)', () => {
    const hit = match(HINTS, 'Filed with State', 'articles_of_organization')
    expect(hit).toHaveLength(1)
    expect(hit[0].asks).toBe('the Articles of Organization from the state')
    expect(hit[0].how).toBe('Upload it in the "Upload Articles of Organization" box.')
    expect(hit[0].workspacePath).toBe('/flows/sd-1?guide=articles_of_organization')
    for (const s of ALL_STAGES.filter((s) => s !== 'Filed with State')) expect(match(HINTS, s, 'articles_of_organization'), s).toHaveLength(0)
  })

  it('fax confirmation: only while the case is at "SS-4 Signed"', () => {
    const hit = match(HINTS, 'SS-4 Signed', 'fax_confirmation', 'correspondence')
    expect(hit).toHaveLength(1)
    expect(hit[0].how).toBe('Upload it in the "Upload fax confirmation/tracking" box.')
    for (const s of ALL_STAGES.filter((s) => s !== 'SS-4 Signed')) expect(match(HINTS, s, 'fax_confirmation', 'correspondence'), s).toHaveLength(0)
  })

  it('EIN letter: at "SS-4 Sent to IRS" (the letter arrives while we wait — 3 real clients are there) AND at "EIN Received"', () => {
    const early = match(HINTS, 'SS-4 Sent to IRS', 'ein_letter_irs')
    expect(early).toHaveLength(1)
    expect(early[0].how).toBe('Press "EIN Received" first, then upload it in the "Upload EIN Letter (CP 575)" box.')
    expect(early[0].workspacePath).toBe('/flows/sd-1?guide=ein_letter_irs')
    const own = match(HINTS, 'EIN Received', 'ein_letter_irs')
    expect(own).toHaveLength(1)
    expect(own[0].how).toBe('Upload it in the "Upload EIN Letter (CP 575)" box.')
    for (const s of ['Payment Confirmed', 'Wizard Submitted', 'Filed with State', 'Articles Received', 'SS-4 Prepared', 'SS-4 Signed']) {
      expect(match(HINTS, s, 'ein_letter_irs'), s).toHaveLength(0)
    }
  })

  it('an ordinary file raises nothing, and so does "Other document" (these boxes have no "Other document" rule)', () => {
    for (const s of ALL_STAGES) {
      for (const t of ['passport', 'operating_agreement', 'form_ss_4', 'other_document', null]) {
        expect(match(HINTS, s, t), `${s} / ${t}`).toHaveLength(0)
      }
    }
  })

  it('a finished case raises nothing', () => {
    expect(matchStorageStepHints({ hints: HINTS, cases: [kase('SS-4 Sent to IRS', SERVICE, 'completed')], documentType: 'ein_letter_irs', folderKind: 'company' })).toHaveLength(0)
    expect(matchStorageStepHints({ hints: HINTS, cases: [kase('SS-4 Sent to IRS', SERVICE, 'cancelled')], documentType: 'ein_letter_irs', folderKind: 'company' })).toHaveLength(0)
  })

  it('the browser skips the check for an ordinary type, and checks the three Formation types', () => {
    for (const t of ['articles_of_organization', 'fax_confirmation', 'ein_letter_irs']) expect(typeCouldWait(HINTS, t), t).toBe(true)
    for (const t of ['passport', 'operating_agreement', 'form_ss_4']) expect(typeCouldWait(HINTS, t), t).toBe(false)
  })
})

describe('Formation and ITIN live side by side without touching each other', () => {
  it('the ITIN rules are unchanged, and the Formation types do not match an ITIN case', () => {
    expect(BOTH.filter((h) => h.serviceType === 'ITIN').map((h) => h.documentTypes[0])).toEqual(['itin_application', 'receipt', 'itin_letter'])
    expect(match(BOTH, 'IRS Processing', 'itin_letter', 'itin', 'ITIN')).toHaveLength(1)
    expect(match(BOTH, 'IRS Processing', 'ein_letter_irs', 'company', 'ITIN')).toHaveLength(0)
    expect(match(BOTH, 'EIN Received', 'itin_letter', 'itin', SERVICE)).toHaveLength(0)
    expect(match(BOTH, 'SS-4 Sent to IRS', 'ein_letter_irs', 'company', SERVICE)).toHaveLength(1)
  })
})

// ── the data change and the test data are the SAME thing ───────────────────────────────────────────────────────────

describe('the data change (SQL) and the test layouts say exactly the same', () => {
  const sql = readFileSync(join(__dirname, '../../scripts/migrations/20261029-0200-formation-upload-box-storage-hints.sql'), 'utf8')
  const blocks = Array.from(sql.matchAll(/\('([^']+)', '([^']+)', \$h\$([\s\S]*?)\$h\$::jsonb\)/g)).map((m) => ({ stage: m[1], docType: m[2], hint: JSON.parse(m[3]) as unknown }))
  const boxOf = (stage: string) =>
    (FORMATION_ROWS.find((r) => r.stage_name === stage)!.stage_layout as { components: Array<{ type: string; label?: string; documentType?: string; storageHint?: unknown }> })
      .components.find((c) => c.type === 'document_upload')!

  it('the SQL carries the three boxes, and each type + hint equals that box in the test layouts', () => {
    expect(blocks.map((b) => b.stage)).toEqual(['Filed with State', 'SS-4 Signed', 'EIN Received'])
    for (const b of blocks) {
      const box = boxOf(b.stage)
      expect(box.documentType, b.stage).toBe(b.docType)
      expect(box.storageHint, b.stage).toEqual(b.hint)
    }
  })

  it('the types are the ones the workspace already assigns by stage in code (no saved file changes type)', () => {
    const code = readFileSync(join(__dirname, '../../lib/crm-store/formation-pilot.ts'), 'utf8')
    for (const b of blocks) expect(code).toContain(`"${b.stage}": "${b.docType}"`)
  })

  it('the guard names the same three boxes by label as the layouts', () => {
    for (const b of blocks) expect(sql).toContain(`'${boxOf(b.stage).label}'`)
  })

  it('the UNDO removes the settings AND the typing from exactly those three stages', () => {
    const undo = readFileSync(join(__dirname, '../../scripts/migrations/20261029-0200-formation-upload-box-storage-hints.UNDO.sql'), 'utf8')
    expect(undo).toContain("c - 'storageHint' - 'documentType'")
    for (const st of ['Filed with State', 'SS-4 Signed', 'EIN Received']) expect(undo).toContain(`'${st}'`)
  })
})
