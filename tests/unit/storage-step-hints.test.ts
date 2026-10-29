/**
 * Dev job e3215801 — "a workspace step is waiting for this document". Real case: Adam Mihaly's ITIN letter was filed in Storage
 * (type "ITIN Letter Client Received", ITIN folder, hidden) on 2026-10-23 while his case was still at "IRS Processing"; the workspace
 * step that reads the letter, tells the client and closes the case never ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fx = vi.hoisted(() => ({
  folder: { kind: 'itin' } as Record<string, unknown> | null,
  owner: { kind: 'person', contact_id: 'c-1', account_id: null } as Record<string, unknown> | null,
  contact: { full_name: 'Adam Mihaly' } as Record<string, unknown> | null,
  account: { company_name: 'Acme LLC' } as Record<string, unknown> | null,
  cases: [] as Array<Record<string, unknown>>,
  stageRows: [] as Array<Record<string, unknown>>,
  fail: { folder: false, owner: false, contact: false, cases: false, stages: false },
  queried: [] as string[],
  filters: [] as Array<[string, unknown]>,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      fx.queried.push(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.in = () => b
      b.order = () => b
      b.eq = (col: string, val: unknown) => { fx.filters.push([`${table}.${col}`, val]); return b }
      const one = () => {
        if (table === 'store_folders') return fx.fail.folder ? { data: null, error: { message: 'boom' } } : { data: fx.folder, error: null }
        if (table === 'store_owners') return fx.fail.owner ? { data: null, error: { message: 'boom' } } : { data: fx.owner, error: null }
        if (table === 'contacts') return fx.fail.contact ? { data: null, error: { message: 'boom' } } : { data: fx.contact, error: null }
        if (table === 'accounts') return { data: fx.account, error: null }
        if (table === 'pipeline_stages') return fx.fail.stages ? { data: null, error: { message: 'boom' } } : { data: fx.stageRows, error: null }
        if (table === 'service_deliveries') return fx.fail.cases ? { data: null, error: { message: 'boom' } } : { data: fx.cases, error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = () => Promise.resolve(one())
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(one()).then(res, rej)
      return b
    },
  },
}))

import { matchStorageStepHints as matchWith, couldMatchAnyHint as couldMatchWith, typeCouldWait as couldWaitWith, findWaitingWorkspaceSteps, findWaitingWorkspaceStepsForContact, buildStepHints, resetStepHintsCache } from '@/lib/flows/storage-step-hints'

// The production ITIN stage rows (their upload boxes carry the storageHint the pop-up is built from) — the rules are BUILT from these, nothing is hardcoded.
const ITIN_ROWS = JSON.parse(readFileSync(join(__dirname, '../fixtures/pipeline-itin-stages.json'), 'utf8')) as Array<{ service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }>
const HINTS = buildStepHints(ITIN_ROWS)
const matchStorageStepHints = (i: Omit<Parameters<typeof matchWith>[0], 'hints'>) => matchWith({ ...i, hints: HINTS })
const couldMatchAnyHint = (t: string | null, f: string | null) => couldMatchWith(HINTS, t, f)
const typeCouldWait = (t: string | null) => couldWaitWith(HINTS, t)

const kase = (stage: string, status = 'active', serviceType = 'ITIN') => ({ sdId: 'sd-1', serviceType, stage, status, who: 'Adam Mihaly' })

describe('matchStorageStepHints — what a Storage save would skip', () => {
  it('"Open the workspace" opens the case WITH the guide on, about the document each row\'s workspace box takes (package / receipt / letter)', () => {
    const pkg = matchStorageStepHints({ cases: [kase('Shipped')], documentType: 'itin_application', folderKind: 'itin' })
    expect(pkg[0].workspacePath).toBe('/flows/sd-1?guide=itin_application')
    const rec = matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'receipt', folderKind: 'itin' })
    expect(rec[0].workspacePath).toBe('/flows/sd-1?guide=receipt')
  })
  it('ADAM: the letter filed as "ITIN Letter Client Received" while the case is at IRS Processing is caught (the stage move had not happened yet)', () => {
    const r = matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'itin_letter_client_received', folderKind: 'itin' })
    expect(r).toHaveLength(1)
    expect(r[0].asks).toBe('the IRS approval letter (CP565)')
    expect(r[0].workspacePath).toBe('/flows/sd-1?guide=itin_letter')   // the guide is about the document the step takes (the row's first type), not the type it was filed as
    expect(r[0].who).toBe('Adam Mihaly')
    expect(r[0].workspaceDoes).toContain('read the ITIN from the letter and save it on the contact')
    expect(r[0].workspaceDoes).toContain('close the case')
    expect(r[0].workspaceDoes).toContain('show the letter to the client')
  })

  it('the letter is caught at Submitted to IRS, IRS Processing and ITIN Approved — and every letter type counts', () => {
    for (const stage of ['Submitted to IRS', 'IRS Processing', 'ITIN Approved']) {
      for (const t of ['itin_letter', 'itin_cp565', 'itin_letter_client_received']) {
        expect(matchStorageStepHints({ cases: [kase(stage)], documentType: t, folderKind: 'itin' }), `${stage} / ${t}`).toHaveLength(1)
      }
    }
  })

  it('nothing is waiting for the letter early in the case (the letter cannot exist yet)', () => {
    for (const stage of ['Data Collection', 'Document Preparation', 'Client Signing', 'Shipped', 'Documents Received', 'CAA Review']) {
      expect(matchStorageStepHints({ cases: [kase(stage)], documentType: 'itin_letter', folderKind: 'itin' }), stage).toHaveLength(0)
    }
  })

  it('a finished case waits for nothing (completed / cancelled)', () => {
    expect(matchStorageStepHints({ cases: [kase('ITIN Approved', 'completed')], documentType: 'itin_letter', folderKind: 'itin' })).toHaveLength(0)
    expect(matchStorageStepHints({ cases: [kase('IRS Processing', 'cancelled')], documentType: 'itin_letter', folderKind: 'itin' })).toHaveLength(0)
  })

  it('the signed package received from the client, at Shipped / Documents Received — it would also move the case on', () => {
    const r = matchStorageStepHints({ cases: [kase('Documents Received')], documentType: 'itin_application', folderKind: 'itin' })
    expect(r[0].asks).toBe('the signed package received from the client')
    expect(r[0].workspaceDoes).toContain('move the case on to the CAA review')
    expect(matchStorageStepHints({ cases: [kase('Shipped')], documentType: 'form_w_7', folderKind: 'itin' })).toHaveLength(1)
    expect(matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'itin_application', folderKind: 'itin' })).toHaveLength(0)
  })

  it('the mailing receipt, at Submitted to IRS only', () => {
    const r = matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'receipt', folderKind: 'itin' })
    expect(r[0].asks).toContain('mailing receipt')
    expect(matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'receipt', folderKind: 'itin' })).toHaveLength(0)
  })

  it('a file typed "Other document" dropped into the ITIN folder counts as the step\'s document (the workspace itself types the letter that way)', () => {
    expect(matchStorageStepHints({ cases: [kase('ITIN Approved')], documentType: 'other_document', folderKind: 'itin' })[0].asks).toBe('the IRS approval letter (CP565)')
    expect(matchStorageStepHints({ cases: [kase('Documents Received')], documentType: 'other_document', folderKind: 'itin' })[0].asks).toContain('package')
    // …but not into any other folder
    expect(matchStorageStepHints({ cases: [kase('ITIN Approved')], documentType: 'other_document', folderKind: 'personal' })).toHaveLength(0)
  })

  it('when two steps could take a vague file the step\'s OWN upload wins (the receipt at Submitted to IRS, not the letter)', () => {
    expect(matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'other_document', folderKind: 'itin' })[0].asks).toContain('mailing receipt')
  })

  it('a passport, a tax return, an unrelated document — even in the ITIN folder — never raises the pop-up', () => {
    for (const t of ['passport', 'id_document', 'form_1040_nr', 'itin_schedule_oi', 'ein_letter_irs']) {
      expect(matchStorageStepHints({ cases: [kase('ITIN Approved')], documentType: t, folderKind: 'itin' }), t).toHaveLength(0)
    }
  })

  it('other services are untouched (only ITIN has rows today)', () => {
    expect(matchStorageStepHints({ cases: [kase('ITIN Approved', 'active', 'Company Formation')], documentType: 'itin_letter', folderKind: 'itin' })).toHaveLength(0)
  })

  it('several cases: only the one that is waiting is returned', () => {
    const r = matchStorageStepHints({
      cases: [{ ...kase('Client Signing'), sdId: 'a' }, { ...kase('IRS Processing'), sdId: 'b' }],
      documentType: 'itin_letter',
      folderKind: 'itin',
    })
    expect(r.map((x) => x.sdId)).toEqual(['b'])
  })

  it('every row names what the workspace does (nothing is claimed that is not listed) and EVERY stage it covers says what to press there', () => {
    for (const h of HINTS) {
      expect(h.stages.length).toBeGreaterThan(0)
      expect(h.documentTypes.length).toBeGreaterThan(0)
      expect(h.asks.length).toBeGreaterThan(5)
      expect(h.workspaceDoes.length).toBeGreaterThan(0)
      for (const stage of h.stages) expect((h.howByStage[stage] ?? '').length, `${h.asks} @ ${stage}`).toBeGreaterThan(10)
    }
  })

  it('the pop-up says the exact next click for the stage the case is at (Adam: "IRS Processing" has NO upload box — press "ITIN Received" first)', () => {
    const letterAt = (stage: string) => matchStorageStepHints({ cases: [kase(stage)], documentType: 'itin_letter', folderKind: 'itin' })[0].how
    expect(letterAt('IRS Processing')).toContain('Press "ITIN Received"')
    expect(letterAt('IRS Processing')).toContain('Upload CP565 ITIN Letter')
    expect(letterAt('ITIN Approved')).toContain('Upload CP565 ITIN Letter')
    // at Submitted to IRS the only box is for the mailing receipt — the letter must NOT go there
    expect(letterAt('Submitted to IRS')).toContain('Submitted - Wait for IRS')
    expect(letterAt('Submitted to IRS')).toContain('ITIN Received')
    expect(letterAt('Submitted to IRS')).toContain('Do not use the "Upload mailing receipt/tracking" box')
    const scanAt = (stage: string) => matchStorageStepHints({ cases: [kase(stage)], documentType: 'itin_application', folderKind: 'itin' })[0].how
    expect(scanAt('Shipped')).toContain('Documents Received at Office')
    expect(scanAt('Documents Received')).toContain('Upload received package scan')
  })

  it('what Storage itself does is told truthfully: a file typed "ITIN Letter" is read by Storage; the other letter types are not', () => {
    const t = (type: string) => matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: type, folderKind: 'itin' })[0]
    const letter = t('itin_letter')
    expect(letter.storageDoes.join(' ')).toContain('read the ITIN number off the letter')
    expect(letter.workspaceDoes).not.toContain('read the ITIN from the letter and save it on the contact')
    expect(letter.workspaceDoes).toContain('show the letter to the client')
    expect(letter.workspaceDoes).toContain('close the case')
    for (const other of ['itin_cp565', 'itin_letter_client_received', 'other_document']) {
      expect(t(other).storageDoes, other).toEqual([])
      expect(t(other).workspaceDoes, other).toContain('read the ITIN from the letter and save it on the contact')
    }
  })

  it('a hit says HOW it matched: the type is the step\'s document, or only "Other document" in the ITIN folder (it MAY be that document)', () => {
    expect(matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'itin_letter', folderKind: 'itin' })[0].matchedBy).toBe('type')
    expect(matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'other_document', folderKind: 'itin' })[0].matchedBy).toBe('folder')
  })

  it('"Receipt" is a generic type: it only counts inside the ITIN folder (an office receipt in another folder is just a receipt)', () => {
    expect(matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'receipt', folderKind: 'itin' })).toHaveLength(1)
    expect(matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'receipt', folderKind: 'personal' })).toHaveLength(0)
    expect(matchStorageStepHints({ cases: [kase('Submitted to IRS')], documentType: 'receipt', folderKind: null })).toHaveLength(0)
  })

  it('the case\'s own person / company ids travel with the hit (the Storage-only note is shown on THEIR activity)', () => {
    const r = matchStorageStepHints({ cases: [{ ...kase('IRS Processing'), contactId: 'c-1', accountId: null }], documentType: 'itin_letter', folderKind: 'itin' })
    expect(r[0].contactId).toBe('c-1')
    expect(r[0].accountId).toBeNull()
    expect(matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'itin_letter', folderKind: 'itin' })[0].contactId).toBeNull()
  })
})

describe('couldMatchAnyHint / typeCouldWait — an ordinary upload is not even sent to the check', () => {
  it('false for ordinary documents, true for the workspace types and the ITIN folder', () => {
    expect(couldMatchAnyHint('passport', 'personal')).toBe(false)
    expect(couldMatchAnyHint('other_document', 'personal')).toBe(false)
    expect(couldMatchAnyHint('articles_of_organization', 'company')).toBe(false)
    expect(couldMatchAnyHint('itin_letter', null)).toBe(true)
    expect(couldMatchAnyHint('other_document', 'itin')).toBe(true)
    expect(couldMatchAnyHint(null, 'itin')).toBe(true)
    expect(couldMatchAnyHint('passport', 'itin')).toBe(false)
    expect(couldMatchAnyHint('receipt', 'personal')).toBe(false)
    expect(couldMatchAnyHint('receipt', 'itin')).toBe(true)
  })

  it('typeCouldWait: ordinary types false (no database, no extra call); workspace types, "Other document", "Receipt" and no type true', () => {
    for (const t of ['passport', 'id_document', 'tax_return', 'articles_of_organization', 'bank_statement', 'form_1040_nr', 'ein_letter_irs']) {
      expect(typeCouldWait(t), t).toBe(false)
    }
    for (const t of ['itin_letter', 'itin_cp565', 'itin_letter_client_received', 'itin_application', 'form_w_7', 'receipt', 'other_document']) {
      expect(typeCouldWait(t), t).toBe(true)
    }
    expect(typeCouldWait(null)).toBe(true)
  })
})

beforeEach(() => {
  resetStepHintsCache()
  fx.stageRows = ITIN_ROWS as unknown as Array<Record<string, unknown>>
  fx.folder = { kind: 'itin' }
  fx.owner = { kind: 'person', contact_id: 'c-1', account_id: null }
  fx.contact = { full_name: 'Adam Mihaly' }
  fx.account = { company_name: 'Acme LLC' }
  fx.cases = [{ id: 'sd-1', service_type: 'ITIN', stage: 'IRS Processing', status: 'active', contact_id: 'c-1', account_id: null }]
  fx.fail = { folder: false, owner: false, contact: false, cases: false, stages: false }
  fx.queried = []
  fx.filters = []
})

describe('findWaitingWorkspaceSteps — the lookup', () => {
  it('ADAM: a person\'s storage, ITIN folder, the letter type -> the open ITIN case, named', async () => {
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter_client_received' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ sdId: 'sd-1', who: 'Adam Mihaly', stage: 'IRS Processing', serviceType: 'ITIN', workspacePath: '/flows/sd-1?guide=itin_letter' })
    expect(fx.filters).toContainEqual(['service_deliveries.contact_id', 'c-1'])
  })

  it('an ordinary upload (a passport, a tax return) answers "nothing waiting" WITHOUT reading anything — not even the folder', async () => {
    fx.folder = { kind: 'personal' }
    for (const t of ['passport', 'tax_return', 'bank_statement']) {
      expect(await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: t })).toEqual([])
    }
    expect(fx.queried).toEqual(['pipeline_stages'])
  })

  it('a generic type that is only sometimes a step\'s document ("Receipt" into Personal documents) reads the folder and stops: no owner, no case lookups', async () => {
    fx.folder = { kind: 'personal' }
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'receipt' })
    expect(r).toEqual([])
    expect(fx.queried).toEqual(['pipeline_stages', 'store_folders'])
  })

  it('the hit carries the case\'s own contact id (and account id) from the case row', async () => {
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
    expect(r[0]).toMatchObject({ contactId: 'c-1', accountId: null, matchedBy: 'type' })
    expect(r[0].how).toContain('ITIN Received')
  })

  it('a person override only counts for a "2. Contacts" folder — anywhere else the save ignores it, so the check uses the storage\'s own owner', async () => {
    fx.folder = { kind: 'itin' }
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter', personContactId: 'c-OTHER' })
    expect(r).toHaveLength(1)
    expect(fx.queried).toContain('store_owners')
    expect(fx.filters).toContainEqual(['service_deliveries.contact_id', 'c-1'])
    expect(fx.filters).not.toContainEqual(['service_deliveries.contact_id', 'c-OTHER'])
  })

  it('a company storage looks at the company\'s own cases', async () => {
    fx.owner = { kind: 'company', contact_id: null, account_id: 'a-1' }
    fx.cases = [{ id: 'sd-9', service_type: 'ITIN', stage: 'ITIN Approved', status: 'active' }]
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-2', folderId: 'f-1', documentType: 'itin_letter' })
    expect(r[0]).toMatchObject({ sdId: 'sd-9', who: 'Acme LLC' })
    expect(fx.filters).toContainEqual(['service_deliveries.account_id', 'a-1'])
  })

  it('saved through a company\'s "2. Contacts": the PERSON\'s cases are used, no owner lookup', async () => {
    fx.folder = { kind: 'contacts' }
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-company', folderId: 'f-1', documentType: 'itin_letter', personContactId: 'c-7' })
    expect(r).toHaveLength(1)
    expect(fx.queried).not.toContain('store_owners')
    expect(fx.filters).toContainEqual(['service_deliveries.contact_id', 'c-7'])
  })

  it('a person with no open case, a firm-internal storage and a missing owner all answer "nothing waiting"', async () => {
    fx.cases = []
    expect(await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).toEqual([])
    fx.owner = { kind: 'private', contact_id: null, account_id: null }
    expect(await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).toEqual([])
    fx.owner = null
    expect(await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).toEqual([])
  })

  it('a record that cannot be read THROWS — the caller refuses the save, it never passes', async () => {
    fx.fail.folder = true
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    fx.fail = { folder: false, owner: true, contact: false, cases: false, stages: false }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    fx.fail = { folder: false, owner: false, contact: true, cases: false, stages: false }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    fx.fail = { folder: false, owner: false, contact: false, cases: true, stages: false }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
  })
})

describe('the rules are read from the stage layouts — a read that fails refuses the save', () => {
  it('stage rows that cannot be read THROW (both doors) instead of letting the file through unchecked', async () => {
    fx.fail.stages = true
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    await expect(findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })).rejects.toThrow()
  })
  it('a layout edit shows up after the short cache (a new box type is noticed); the rows are read once for a burst of uploads', async () => {
    await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
    await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
    expect(fx.queried.filter((t) => t === 'pipeline_stages')).toHaveLength(1)
    resetStepHintsCache()
    await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
    expect(fx.queried.filter((t) => t === 'pipeline_stages')).toHaveLength(2)
  })
})

describe('the stage read must not block every upload on a blip (stale copy), and bad box settings are logged', () => {
  it('a read that fails AFTER a good one reuses the last good copy (a passport upload is not refused because of a blip)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const first = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
      expect(first).toHaveLength(1)
      vi.setSystemTime(Date.now() + 31_000)          // the 30 s copy has expired: the next call re-reads
      fx.fail.stages = true
      expect(await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'passport' })).toEqual([])
      const again = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
      expect(again).toHaveLength(1)                   // still protected, from the last good copy
      expect(warn.mock.calls.some((c) => String(c[0]).includes('last good copy'))).toBe(true)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('with NO earlier copy (a cold instance) the read still THROWS — never "check nothing"', async () => {
    fx.fail.stages = true
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'passport' })).rejects.toThrow()
  })

  it('upload-box settings that would silently switch a pop-up off are logged when the layouts are read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fx.stageRows = [
      { service_type: 'X', stage_name: 'Go', stage_order: 1, stage_layout: { components: [{ type: 'document_upload', label: 'Up', documentType: 'x_doc', storageHint: { typeNeedsFolder: true } }] } },
    ] as unknown as Array<Record<string, unknown>>
    await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'x_doc' })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('switch a pop-up off') && String(c[1]).includes('need a folderKind'))).toBe(true)
    warn.mockRestore()
  })

  it('the real ITIN layouts raise no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('findWaitingWorkspaceStepsForContact — the contact page\'s upload ("Door A")', () => {
  it('a person\'s ITIN letter -> their open ITIN case, found by the CONTACT directly (no storage owner, no folder lookup)', async () => {
    const r = await findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ sdId: 'sd-1', who: 'Adam Mihaly', stage: 'IRS Processing', contactId: 'c-1', matchedBy: 'type' })
    expect(fx.filters).toContainEqual(['service_deliveries.contact_id', 'c-1'])
    expect(fx.queried).not.toContain('store_owners')
    expect(fx.queried).not.toContain('store_folders')
  })

  it('an ordinary type (a passport, a bank statement) answers "nothing waiting" WITHOUT reading anything', async () => {
    for (const t of ['passport', 'bank_statement', 'ein_letter_irs']) {
      expect(await findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: t, folderKind: null }), t).toEqual([])
    }
    // a generic type that only counts inside the ITIN folder ("Receipt", filed elsewhere) is also not looked up
    expect(await findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'receipt', folderKind: null })).toEqual([])
    expect(fx.queried).toEqual(['pipeline_stages'])
  })

  it('a person with no open case, or a finished one, has nothing waiting; a record that cannot be read THROWS (the caller refuses the upload)', async () => {
    fx.cases = []
    expect(await findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })).toEqual([])
    fx.cases = [{ id: 'sd-2', service_type: 'ITIN', stage: 'ITIN Approved', status: 'completed', contact_id: 'c-1', account_id: null }]
    expect(await findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })).toEqual([])
    fx.fail.cases = true
    await expect(findWaitingWorkspaceStepsForContact({ contactId: 'c-1', documentType: 'itin_letter', folderKind: 'itin' })).rejects.toThrow()
  })
})

