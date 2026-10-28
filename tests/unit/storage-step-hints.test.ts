/**
 * Dev job e3215801 — "a workspace step is waiting for this document". Real case: Adam Mihaly's ITIN letter was filed in Storage
 * (type "ITIN Letter Client Received", ITIN folder, hidden) on 2026-10-23 while his case was still at "IRS Processing"; the workspace
 * step that reads the letter, tells the client and closes the case never ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  folder: { kind: 'itin' } as Record<string, unknown> | null,
  owner: { kind: 'person', contact_id: 'c-1', account_id: null } as Record<string, unknown> | null,
  contact: { full_name: 'Adam Mihaly' } as Record<string, unknown> | null,
  account: { company_name: 'Acme LLC' } as Record<string, unknown> | null,
  cases: [] as Array<Record<string, unknown>>,
  fail: { folder: false, owner: false, contact: false, cases: false },
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
      b.eq = (col: string, val: unknown) => { fx.filters.push([`${table}.${col}`, val]); return b }
      const one = () => {
        if (table === 'store_folders') return fx.fail.folder ? { data: null, error: { message: 'boom' } } : { data: fx.folder, error: null }
        if (table === 'store_owners') return fx.fail.owner ? { data: null, error: { message: 'boom' } } : { data: fx.owner, error: null }
        if (table === 'contacts') return fx.fail.contact ? { data: null, error: { message: 'boom' } } : { data: fx.contact, error: null }
        if (table === 'accounts') return { data: fx.account, error: null }
        if (table === 'service_deliveries') return fx.fail.cases ? { data: null, error: { message: 'boom' } } : { data: fx.cases, error: null }
        return { data: null, error: null }
      }
      b.maybeSingle = () => Promise.resolve(one())
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(one()).then(res, rej)
      return b
    },
  },
}))

import { matchStorageStepHints, couldMatchAnyHint, findWaitingWorkspaceSteps, STORAGE_STEP_HINTS } from '@/lib/flows/storage-step-hints'

const kase = (stage: string, status = 'active', serviceType = 'ITIN') => ({ sdId: 'sd-1', serviceType, stage, status, who: 'Adam Mihaly' })

describe('matchStorageStepHints — what a Storage save would skip', () => {
  it('ADAM: the letter filed as "ITIN Letter Client Received" while the case is at IRS Processing is caught (the stage move had not happened yet)', () => {
    const r = matchStorageStepHints({ cases: [kase('IRS Processing')], documentType: 'itin_letter_client_received', folderKind: 'itin' })
    expect(r).toHaveLength(1)
    expect(r[0].asks).toBe('the IRS approval letter (CP565)')
    expect(r[0].workspacePath).toBe('/flows/sd-1')
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

  it('every row names what the workspace does (nothing is claimed that is not listed)', () => {
    for (const h of STORAGE_STEP_HINTS) {
      expect(h.stages.length).toBeGreaterThan(0)
      expect(h.documentTypes.length).toBeGreaterThan(0)
      expect(h.asks.length).toBeGreaterThan(5)
      expect(h.workspaceDoes.length).toBeGreaterThan(0)
    }
  })
})

describe('couldMatchAnyHint — an ordinary upload never touches the database', () => {
  it('false for ordinary documents, true for the workspace types and the ITIN folder', () => {
    expect(couldMatchAnyHint('passport', 'personal')).toBe(false)
    expect(couldMatchAnyHint('other_document', 'personal')).toBe(false)
    expect(couldMatchAnyHint('articles_of_organization', 'company')).toBe(false)
    expect(couldMatchAnyHint('itin_letter', null)).toBe(true)
    expect(couldMatchAnyHint('other_document', 'itin')).toBe(true)
    expect(couldMatchAnyHint(null, 'itin')).toBe(true)
    expect(couldMatchAnyHint('passport', 'itin')).toBe(false)
  })
})

beforeEach(() => {
  fx.folder = { kind: 'itin' }
  fx.owner = { kind: 'person', contact_id: 'c-1', account_id: null }
  fx.contact = { full_name: 'Adam Mihaly' }
  fx.account = { company_name: 'Acme LLC' }
  fx.cases = [{ id: 'sd-1', service_type: 'ITIN', stage: 'IRS Processing', status: 'active' }]
  fx.fail = { folder: false, owner: false, contact: false, cases: false }
  fx.queried = []
  fx.filters = []
})

describe('findWaitingWorkspaceSteps — the lookup', () => {
  it('ADAM: a person\'s storage, ITIN folder, the letter type -> the open ITIN case, named', async () => {
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter_client_received' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ sdId: 'sd-1', who: 'Adam Mihaly', stage: 'IRS Processing', serviceType: 'ITIN', workspacePath: '/flows/sd-1' })
    expect(fx.filters).toContainEqual(['service_deliveries.contact_id', 'c-1'])
  })

  it('an ordinary upload (a passport into Personal documents) reads only the folder and stops: no owner, no case lookups', async () => {
    fx.folder = { kind: 'personal' }
    const r = await findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'passport' })
    expect(r).toEqual([])
    expect(fx.queried).toEqual(['store_folders'])
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
    fx.fail = { folder: false, owner: true, contact: false, cases: false }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    fx.fail = { folder: false, owner: false, contact: true, cases: false }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
    fx.fail = { folder: false, owner: false, contact: false, cases: true }
    await expect(findWaitingWorkspaceSteps({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter' })).rejects.toThrow()
  })
})
