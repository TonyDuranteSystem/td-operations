/**
 * Dev job e3215801 — the Company Change Name workspace joins the "a workspace step is waiting for this document" pop-up and the guide, by DATA only:
 * its upload box "Upload the state's stamped document" (stage "Waiting for the state") carries a `documentType` + `storageHint`
 * (scripts/migrations/20261029-2200-…). Antonio approved the wording 2026-10-29 ("using this wording"). The layouts are dumped from the sandbox AFTER the
 * data change (tests/fixtures/pipeline-change-name-stages.json).
 *
 * The other upload box of this service ("File the form with the state", proof of filing) is left untyped on purpose: nothing depends on its stamp, and two
 * boxes of one service cannot share one type.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildStepHints, matchStorageStepHints, stepHintProblems, typeCouldWait, type StorageStepHint } from '@/lib/flows/storage-step-rules'
import { CHANGE_NAME_STAGES, CHANGE_NAME_STAGE_ORDER } from '@/lib/flows/change-name-stages'
import { CLIENT_SAFE_FLOW_DOC_STAGES } from '@/lib/flows/flow-doc-visibility'

type Row = { service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8')
const CN_ROWS = JSON.parse(read('../fixtures/pipeline-change-name-stages.json')) as Row[]
const ITIN_ROWS = JSON.parse(read('../fixtures/pipeline-itin-stages.json')) as Row[]
const FORMATION_ROWS = JSON.parse(read('../fixtures/pipeline-formation-stages.json')) as Row[]
const HINTS = buildStepHints(CN_ROWS)
const ALL = buildStepHints([...ITIN_ROWS, ...FORMATION_ROWS, ...CN_ROWS])
const SERVICE = 'Company Change Name'
const WAIT = CHANGE_NAME_STAGES.wait
const kase = (stage: string, serviceType = SERVICE, status = 'active') => ({ sdId: 'sd-1', serviceType, stage, status, who: 'Beta LLC' })
const match = (hints: readonly StorageStepHint[], stage: string, documentType: string | null, folderKind: string | null = 'company', serviceType = SERVICE) =>
  matchStorageStepHints({ hints, cases: [kase(stage, serviceType)], documentType, folderKind })

// every kind of folder a Storage save can land in (production, checked 2026-10-29): company storages, person storages, the rest
const NON_COMPANY_FOLDER_KINDS = ['banking', 'contacts', 'correspondence', 'custom', 'root', 'tax', 'tax_year', 'itin', 'person_tax', 'person_tax_year', 'personal', 'private_root', 'staff_share']

describe('the Company Change Name rule built from the real layouts', () => {
  it('exactly one row: the "Waiting for the state" box, which takes "Other document"', () => {
    expect(HINTS.map((h) => [h.boxStage, h.documentTypes])).toEqual([[WAIT, ['other_document']]])
    expect(HINTS[0].serviceType).toBe(SERVICE)
    expect(HINTS[0].boxLabel).toBe("Upload the state's stamped document")
    expect(HINTS[0].stages).toEqual([WAIT])
  })

  it('the words and what the workspace does (the sentences Antonio approved, 2026-10-29)', () => {
    const [h] = HINTS
    expect(h.asks).toBe("the state's stamped document approving the new name")
    expect(h.workspaceDoes.map((e) => e.text)).toEqual([
      'attach it to the case ("Apply new name" needs it)',
      'show it to the client',
      'rename it "State approved name change – company name" and file it in the "1. Company" folder',
    ])
  })

  it('it counts only inside a COMPANY folder (a Change Name case belongs to the company AND the person)', () => {
    const [h] = HINTS
    expect(h.folderKind).toBe('company')
    expect(h.typeNeedsFolder).toBe(true)
    expect(h.vagueTypes).toBeUndefined()
  })

  it('the proof-of-filing box is untouched: no type, so no rule', () => {
    const fileStage = CN_ROWS.find((r) => r.stage_name === CHANGE_NAME_STAGES.file)!
    const box = (fileStage.stage_layout as { components: Array<{ type: string; documentType?: unknown; storageHint?: unknown }> }).components.find((c) => c.type === 'document_upload')!
    expect(box.documentType).toBeUndefined()
    expect(box.storageHint).toBeUndefined()
  })

  it('the settings checker finds nothing wrong with the real layouts, alone or next to ITIN and Formation', () => {
    expect(stepHintProblems(CN_ROWS)).toEqual([])
    expect(stepHintProblems([...ITIN_ROWS, ...FORMATION_ROWS, ...CN_ROWS])).toEqual([])
  })
})

describe('when the state\'s document raises the pop-up', () => {
  it('a file typed "Other document" going into the company\'s Company folder, while the case is at "Waiting for the state"', () => {
    const hit = match(HINTS, WAIT, 'other_document', 'company')
    expect(hit).toHaveLength(1)
    expect(hit[0].asks).toBe("the state's stamped document approving the new name")
    expect(hit[0].matchedBy).toBe('type')
    expect(hit[0].how).toBe('Upload it in the "Upload the state\'s stamped document" box.')
    expect(hit[0].workspacePath).toBe('/flows/sd-1?guide=other_document')
    expect(hit[0].storageDoes).toEqual([])
  })

  it('NOT at any other step of the service', () => {
    for (const s of CHANGE_NAME_STAGE_ORDER.filter((s) => s !== WAIT)) expect(match(HINTS, s, 'other_document', 'company'), s).toHaveLength(0)
  })

  it('NOT in any other kind of folder — a person\'s storage (personal, itin, tax…) or a company\'s other folders never raises it', () => {
    for (const f of NON_COMPANY_FOLDER_KINDS) expect(match(HINTS, WAIT, 'other_document', f), f).toHaveLength(0)
    expect(match(HINTS, WAIT, 'other_document', null)).toHaveLength(0)
  })

  it('NOT for any other document type', () => {
    for (const t of ['passport', 'receipt', 'operating_agreement', 'ein_letter_irs', 'articles_of_organization', 'form_8822_b', 'itin_letter']) {
      expect(match(HINTS, WAIT, t, 'company'), t).toHaveLength(0)
    }
  })

  it('an UNTYPED file in the Company folder counts as a "maybe" (matched by the folder), the same way an untyped file does for ITIN', () => {
    const hit = match(HINTS, WAIT, null, 'company')
    expect(hit).toHaveLength(1)
    expect(hit[0].matchedBy).toBe('folder')
    expect(match(HINTS, WAIT, null, 'personal')).toHaveLength(0)
  })

  it('a finished case raises nothing', () => {
    for (const status of ['completed', 'cancelled']) {
      expect(matchStorageStepHints({ hints: HINTS, cases: [kase(WAIT, SERVICE, status)], documentType: 'other_document', folderKind: 'company' })).toHaveLength(0)
    }
  })

  it('the browser skips the check for an ordinary type and checks "Other document"', () => {
    expect(typeCouldWait(HINTS, 'other_document')).toBe(true)
    for (const t of ['passport', 'operating_agreement', 'receipt', 'ein_letter_irs']) expect(typeCouldWait(HINTS, t), t).toBe(false)
  })
})

describe('Change Name lives side by side with ITIN and Formation without touching them', () => {
  it('the ITIN and Formation rules are unchanged', () => {
    expect(ALL.filter((h) => h.serviceType === 'ITIN').map((h) => h.documentTypes[0])).toEqual(['itin_application', 'receipt', 'itin_letter'])
    expect(ALL.filter((h) => h.serviceType === 'Company Formation').map((h) => h.documentTypes[0])).toEqual(['articles_of_organization', 'fax_confirmation', 'ein_letter_irs'])
    expect(ALL.filter((h) => h.serviceType === SERVICE).map((h) => h.documentTypes[0])).toEqual(['other_document'])
  })

  it('an "Other document" in an ITIN folder still belongs to the ITIN case, never to a Change Name case', () => {
    expect(match(ALL, 'IRS Processing', 'other_document', 'itin', 'ITIN').map((m) => m.serviceType)).toEqual(['ITIN'])
    expect(match(ALL, WAIT, 'other_document', 'itin', SERVICE)).toHaveLength(0)
  })

  it('an "Other document" in a company folder does not raise anything for a Formation or ITIN case', () => {
    for (const s of ['Filed with State', 'SS-4 Signed', 'EIN Received', 'SS-4 Sent to IRS']) expect(match(ALL, s, 'other_document', 'company', 'Company Formation'), s).toHaveLength(0)
    for (const s of ['Documents Received', 'Submitted to IRS', 'IRS Processing', 'ITIN Approved']) expect(match(ALL, s, 'other_document', 'company', 'ITIN'), s).toHaveLength(0)
  })

  it('one Change Name case beside a Formation case of the same company: only the Change Name one is told', () => {
    const hit = matchStorageStepHints({
      hints: ALL,
      cases: [kase(WAIT), { sdId: 'sd-2', serviceType: 'Company Formation', stage: 'EIN Received', status: 'active', who: 'Beta LLC' }],
      documentType: 'other_document',
      folderKind: 'company',
    })
    expect(hit.map((h) => h.sdId)).toEqual(['sd-1'])
  })
})

// ── what the pop-up tells Antonio's staff is TRUE of the code: the sentences are claims, so tie them to it ──────────────

describe('the sentences are true of the code', () => {
  it('"Apply new name" needs a document stamped with this very step', () => {
    const apply = read('../../lib/operations/change-name-apply.ts')
    expect(apply).toContain(".eq('flow_stage', CHANGE_NAME_STAGES.wait)")
    expect(apply).toContain('hasStampedDocument')
  })

  it('the client is shown a document stamped with this step (and the allowlist lists no other Change Name step)', () => {
    expect(Array.from(CLIENT_SAFE_FLOW_DOC_STAGES[SERVICE])).toEqual([WAIT])
  })

  it('the box files the document in "1. Company" under that name (the layout says so)', () => {
    const stage = CN_ROWS.find((r) => r.stage_name === WAIT)!
    const box = (stage.stage_layout as { components: Array<{ type: string; folder?: string; rename?: string; autoAdvance?: boolean }> }).components.find((c) => c.type === 'document_upload')!
    expect(box.folder).toBe('1. Company')
    expect(box.rename).toBe('State approved name change – {company_name}')
    expect(box.autoAdvance).toBe(false)
  })

  it('"Other document" is the type the workspace already gives this file, so no saved file changes type', () => {
    expect(read('../../lib/crm-store/save-for-account.ts')).toContain('export const GENERIC_CLIENT_TYPE = "other_document"')
  })
})

// ── the data change and the test data are the SAME thing ───────────────────────────────────────────────────────────

describe('the data change (SQL) and the test layouts say exactly the same', () => {
  const sql = read('../../scripts/migrations/20261029-2200-change-name-upload-box-storage-hints.sql')
  const blocks = Array.from(sql.matchAll(/\('([^']+)', '([^']+)', \$h\$([\s\S]*?)\$h\$::jsonb\)/g)).map((m) => ({ stage: m[1], docType: m[2], hint: JSON.parse(m[3]) as unknown }))
  const boxOf = (stage: string) =>
    (CN_ROWS.find((r) => r.stage_name === stage)!.stage_layout as { components: Array<{ type: string; label?: string; documentType?: string; storageHint?: unknown }> })
      .components.find((c) => c.type === 'document_upload')!

  it('the SQL carries the one box, and its type + hint equal that box in the test layouts', () => {
    expect(blocks.map((b) => b.stage)).toEqual([WAIT])
    for (const b of blocks) {
      const box = boxOf(b.stage)
      expect(box.documentType, b.stage).toBe(b.docType)
      expect(box.storageHint, b.stage).toEqual(b.hint)
    }
  })

  it('the guard names the box by its label, and the type it relies on', () => {
    expect(sql).toContain(boxOf(WAIT).label!.replace(/'/g, "''"))
    expect(sql).toContain("slug = 'other_document'")
  })

  it('the data change touches no other stage', () => {
    expect(sql).toContain("ps.service_type = 'Company Change Name' AND ps.stage_name = v.stage")
    expect(sql.match(/\$h\$::jsonb/g)).toHaveLength(1)
  })

  it('the UNDO removes the settings AND the typing from exactly that stage', () => {
    const undo = read('../../scripts/migrations/20261029-2200-change-name-upload-box-storage-hints.UNDO.sql')
    expect(undo).toContain("c - 'storageHint' - 'documentType'")
    expect(undo).toContain(`'${WAIT}'`)
    expect(undo).toContain("'Company Change Name'")
  })
})
