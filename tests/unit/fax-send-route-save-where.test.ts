/**
 * The REAL /api/tools/fax/send route with the "Where should this be saved?" choice (dev job c43a8b2e):
 * the place is checked BEFORE the fax goes out; the fax goes out whatever the choice; "Don't save" keeps today's internal copy;
 * a stored document (the one-click EIN fax) is never copied again; a personal paper is never listed on a company's Documents tab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DestinationDeps, FileDeps, OwnerRow, ResolveDeps } from '@/lib/crm-store/save-destination'

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = U(1), FOLDER = U(2), BIZ = U(3), BIZROOT = U(4)

const st = vi.hoisted(() => ({
  user: { id: '00000000-0000-4000-8000-0000000000aa', email: 'luca@tonydurante.us', app_metadata: { role: 'team' } } as Record<string, unknown>,
  sendCalls: 0, sendOk: true, errors: [] as string[], actionLog: [] as Array<Record<string, unknown>>, bucketUploads: [] as string[], docInserts: [] as Array<Record<string, unknown>>,
  storeReads: 0,
  owners: {} as Record<string, unknown>, folders: {} as Record<string, unknown>, companyState: 'store' as string,
  files: new Map<string, { fileId: string; name: string }>(), rows: [] as Array<Record<string, unknown>>, saves: [] as string[], saveThrows: false,
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true, isOwnerOnly: () => false }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => { throw new Error('Drive must not be used') } }))
vi.mock('@/lib/fax/faxage', () => ({
  sendFax: async () => { st.sendCalls++; return st.sendOk ? { ok: true, jobId: 'J1', raw: 'ok' } : { ok: false, jobId: null, raw: 'ERR99 bad' } },
  isValidFaxNo: () => true, normalizeFaxNo: (x: string) => x, DEFAULT_IRS_FAX_NUMBER: '1', stripBase64Prefix: (x: string) => x,
}))
vi.mock('@/lib/crm-store/document-pointer', () => ({
  parseStorePointer: (p: string) => (p.startsWith('store:') ? p.slice(6) : null), staffOnlyStorePointers: async () => new Set(),
  readStoreFile: async () => { st.storeReads++; return { bytes: Buffer.from('%PDF stored'), name: 'SS-4 package.pdf' } },
}))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async (e: { message: string }) => { st.errors.push(e.message) } }))
vi.mock('@/lib/crm-store/save-destination', async (orig) => {
  const real = await orig<typeof import('@/lib/crm-store/save-destination')>()
  const dd: DestinationDeps = {
    readOwner: async (id) => (st.owners[id] as OwnerRow | undefined) ?? null,
    readFolder: async (id) => (st.folders[id] as { id: string; owner_id: string; kind: string; trashed_at: string | null } | undefined) ?? null,
    companyState: async () => st.companyState as 'store' | 'moving' | 'drive',
    noStorageSentence: async () => 'NO-STORAGE-SENTENCE',
    access: async () => true,
  }
  const fd: FileDeps = {
    ensureFolder: async () => U(50),
    save: async (p) => {
      if (st.saveThrows) throw new Error('storage down')
      st.saves.push(`${p.documentType}:${p.name}`)
      const have = st.files.get(p.callerKey)
      if (have) return { fileId: have.fileId, status: 'unchanged', name: have.name }
      const f = { fileId: U(100 + st.files.size), name: p.name }; st.files.set(p.callerKey, f)
      return { fileId: f.fileId, status: 'created', name: p.name }
    },
    upsertRow: async (fileId, row) => { const ex = st.rows.find((r) => r.fileId === fileId); if (ex) return { id: String(ex.id) }; const r = { ...row, fileId, id: `row-${st.rows.length + 1}` }; st.rows.push(r); return { id: String(r.id) } },
    trash: async () => {}, rowLinks: async (o) => ({ account: o.account_id, contact: o.contact_id }),
    pathOf: async () => 'Acme › 3. Tax › 2025', documentTypeLabel: async () => 'IRS Fax',
  }
  const rd: ResolveDeps = {
    liveOwnerOfAccount: async () => OWNER, companyState: async () => st.companyState as 'store' | 'moving' | 'drive', noStorageSentenceForAccount: async () => 'NO-STORAGE-SENTENCE',
    folderOfKind: async () => FOLDER, businessOwnerId: async () => BIZ, topFolder: async () => BIZROOT, childFolderId: async () => null, pathOf: async () => 'x',
  }
  return { ...real, realDestinationDeps: () => dd, realFileDeps: () => fd, realResolveDeps: () => rd }
})
vi.mock('@/lib/supabase-admin', () => {
  const b = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle']) c[m] = () => c
    c.insert = (row: Record<string, unknown>) => { if (table === 'action_log') st.actionLog.push(row); if (table === 'documents') st.docInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'bucket-doc' } }) }), then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) } }
    c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: table === 'documents' ? { id: 'stored-doc', file_name: 'SS-4 package.pdf', drive_file_id: 'store:sf-1', account_id: 'acc-1' } : null, error: null }).then(r)
    return c
  }
  return { supabaseAdmin: { from: b, storage: { from: () => ({ upload: async (p: string) => { st.bucketUploads.push(p); return { error: null } }, createSignedUrl: async () => ({ data: { signedUrl: 'https://x' } }) }) } } }
})

process.env.FAXAGE_USERNAME = 'u'; process.env.FAXAGE_PASSWORD = 'p'
const saveChoice = (over: Record<string, unknown> = {}) => ({ mode: 'save', purpose: 'irs_tax_return', ownerId: OWNER, folderId: FOLDER, newFolderName: null, fileName: '2025 Tax Return - Acme', ...over })
const send = async (extra: Record<string, unknown> = {}) => {
  const { POST } = await import('@/app/api/tools/fax/send/route')
  const res = await POST(new NextRequest('http://localhost/api/tools/fax/send', { method: 'POST', body: JSON.stringify({ faxno: '3055551212', file_base64: Buffer.from('%PDF').toString('base64'), file_name: '2025 Tax Return - Acme.pdf', ...extra }) }))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  st.user = { id: '00000000-0000-4000-8000-0000000000aa', email: 'luca@tonydurante.us', app_metadata: { role: 'team' } }
  st.sendCalls = 0; st.sendOk = true; st.errors.length = 0; st.actionLog.length = 0; st.bucketUploads.length = 0; st.docInserts.length = 0; st.storeReads = 0
  st.companyState = 'store'; st.files.clear(); st.rows.length = 0; st.saves.length = 0; st.saveThrows = false
  st.owners = {
    [OWNER]: { id: OWNER, kind: 'company', study_only: false, account_id: 'acc-1', contact_id: null, service_delivery_id: null },
    [BIZ]: { id: BIZ, kind: 'business', study_only: false, account_id: null, contact_id: null, service_delivery_id: null },
  }
  st.folders = {
    [FOLDER]: { id: FOLDER, owner_id: OWNER, kind: 'tax', trashed_at: null },
    [BIZROOT]: { id: BIZROOT, owner_id: BIZ, kind: 'root', trashed_at: null },
  }
})

describe('/api/tools/fax/send — Save here and send', () => {
  it('destination ok: the fax goes out, the file is filed (IRS Fax, hidden, listed), NO bucket copy, History links the stored row', async () => {
    const r = await send({ save_choice: saveChoice() })
    expect(r.status).toBe(200); expect(r.body.success).toBe(true)
    expect(st.sendCalls).toBe(1)
    expect(st.saves).toEqual(['irs_fax:2025 Tax Return - Acme.pdf'])
    expect(st.rows[0]).toMatchObject({ account_id: 'acc-1', portal_visible: false, document_type_name: 'IRS Fax' })
    expect(st.bucketUploads).toEqual([])
    expect(st.actionLog[0]).toMatchObject({ account_id: 'acc-1', record_id: 'row-1' })
    expect(r.body.saved).toMatchObject({ path: 'Acme › 3. Tax › 2025' })
  })
  it('Business › Fax (a new folder): filed with no type and no CRM row; the internal copy keeps the History link', async () => {
    const r = await send({ save_choice: saveChoice({ purpose: 'third_party', ownerId: BIZ, folderId: BIZROOT, newFolderName: 'Fax' }) })
    expect(r.body.success).toBe(true)
    expect(st.saves).toEqual(['null:2025 Tax Return - Acme.pdf'])
    expect(st.rows).toEqual([])
    expect(st.bucketUploads).toHaveLength(1)
    expect(st.actionLog[0].record_id).toBe('bucket-doc')
    expect(st.actionLog[0].account_id).toBeNull()
  })
  it('double send of the same file = ONE stored file and ONE row', async () => {
    await send({ save_choice: saveChoice() })
    await send({ save_choice: saveChoice() })
    expect(st.files.size).toBe(1); expect(st.rows).toHaveLength(1)
    expect(st.sendCalls).toBe(2)
  })
})

describe("/api/tools/fax/send — Don't save, just send", () => {
  it("keeps today's internal copy (so View Document still opens), files nothing in the storage", async () => {
    const r = await send({ save_choice: { mode: 'dont_save' } })
    expect(r.body.success).toBe(true); expect(st.sendCalls).toBe(1)
    expect(st.saves).toEqual([]); expect(st.rows).toEqual([])
    expect(st.bucketUploads).toHaveLength(1)
    expect(st.docInserts[0]).toMatchObject({ portal_visible: false, notify_client: false })
    expect(st.actionLog[0]).toMatchObject({ record_id: 'bucket-doc' })
    expect((st.actionLog[0].details as Record<string, unknown>).save_choice).toBe('dont_save')
  })
  it('no choice at all (an older caller that sends an already-stored file) behaves the same way', async () => {
    const r = await send()
    expect(r.body.success).toBe(true); expect(st.saves).toEqual([]); expect(st.bucketUploads).toHaveLength(1)
  })
  it("a personal paper's internal copy is attached to NO company", async () => {
    await send({ save_choice: { mode: 'dont_save' }, file_name: 'SS-4 Rossi.pdf', account_id: 'acc-1' })
    expect(st.docInserts[0].account_id).toBeNull()
    st.docInserts.length = 0
    await send({ save_choice: { mode: 'dont_save' }, file_name: '2025 Tax Return.pdf', account_id: 'acc-1' })
    expect(st.docInserts[0].account_id).toBe('acc-1')
  })
})

describe('/api/tools/fax/send — a place that is not allowed stops BEFORE the fax is sent', () => {
  const refused = async (extra: Record<string, unknown>, text: RegExp | string) => {
    const r = await send(extra)
    expect(r.status).toBe(422); expect(r.body.success).toBe(false); expect(r.body.destination_error).toBe(true)
    expect(r.body.error).toMatch(text)
    expect(st.sendCalls).toBe(0); expect(st.saves).toEqual([]); expect(st.bucketUploads).toEqual([]); expect(st.actionLog).toEqual([])
  }
  it('a folder of another owner', async () => { st.folders[FOLDER] = { id: FOLDER, owner_id: BIZ, kind: 'tax', trashed_at: null }; await refused({ save_choice: saveChoice() }, /not in the place you chose/) })
  it('a trashed folder', async () => { st.folders[FOLDER] = { id: FOLDER, owner_id: OWNER, kind: 'tax', trashed_at: '2026-01-01' }; await refused({ save_choice: saveChoice() }, /trash/) })
  it('a company left on Drive / closed (study-only) → the plain sentence', async () => { st.owners[OWNER] = { id: OWNER, kind: 'company', study_only: true, account_id: 'acc-1', contact_id: null, service_delivery_id: null }; await refused({ save_choice: saveChoice() }, 'NO-STORAGE-SENTENCE') })
  it('a company being moved', async () => { st.companyState = 'moving'; await refused({ save_choice: saveChoice() }, /being moved/) })
  it('a company mid-move with no live storage yet hears "moving", not the other sentence', async () => { st.companyState = 'moving'; st.owners[OWNER] = { id: OWNER, kind: 'company', study_only: true, account_id: 'acc-1', contact_id: null, service_delivery_id: null }; await refused({ save_choice: saveChoice() }, /being moved/) })
  it('a person\'s identity paper into a company', async () => { await refused({ save_choice: saveChoice(), file_name: 'Passport.pdf' }, /person's own paper/); await refused({ save_choice: saveChoice({ fileName: 'doc' }), file_name: 'Passport.pdf' }, /person's own paper/) })
  it('the top folder of a client', async () => { st.folders[FOLDER] = { id: FOLDER, owner_id: OWNER, kind: 'root', trashed_at: null }; await refused({ save_choice: saveChoice() }, /Open one of the folders first/) })
  it('not staff of the storage → 403 before the send', async () => {
    st.user = { id: 'x', email: 'p@x', app_metadata: { role: 'partner' } }
    const r = await send({ save_choice: saveChoice() })
    expect(r.status).toBe(403); expect(st.sendCalls).toBe(0)
  })
  it('a malformed choice', async () => { const r = await send({ save_choice: { mode: 'maybe' } }); expect(r.status).toBe(400); expect(st.sendCalls).toBe(0) })
  it('a place that does not exist', async () => { st.owners = {}; await refused({ save_choice: saveChoice() }, /no longer exists/) })
})

describe('/api/tools/fax/send — a STALE proposal is refused before the fax is sent', () => {
  const proposed = (over: Record<string, unknown>) => saveChoice({ proposalOf: { accountId: U(7), business: false }, ...over })
  it("the name was edited to 2019 but the 2025 place was sent → 422, nothing sent, nothing filed", async () => {
    // the proposal made for "2025 …" was: Tax folder + a new folder "2025"; the name now says 2019
    const r = await send({ save_choice: proposed({ newFolderName: '2025', fileName: '2019 Tax Return - Acme' }) })
    expect(r.status).toBe(422); expect(r.body.destination_error).toBe(true); expect(r.body.error).toMatch(/proposed place changed/)
    expect(st.sendCalls).toBe(0); expect(st.saves).toEqual([]); expect(st.bucketUploads).toEqual([])
  })
  it('a proposal that still matches the current answers goes through', async () => {
    const r = await send({ save_choice: proposed({ newFolderName: '2019', fileName: '2019 Tax Return - Acme' }) })
    expect(r.body.success).toBe(true); expect(st.sendCalls).toBe(1); expect(st.saves).toHaveLength(1)
  })
  it('a place staff picked with Change place is not re-derived (their own choice)', async () => {
    const r = await send({ save_choice: saveChoice({ fileName: '2019 Tax Return - Acme' }) })
    expect(r.body.success).toBe(true)
  })
})

describe('/api/tools/fax/send — when the send or the filing goes wrong', () => {
  it('the fax is REFUSED by Faxage → nothing is filed, no copy, no activity-log row', async () => {
    st.sendOk = false
    const r = await send({ save_choice: saveChoice() })
    expect(r.status).toBe(502); expect(r.body.success).toBe(false)
    expect(st.saves).toEqual([]); expect(st.rows).toEqual([]); expect(st.bucketUploads).toEqual([]); expect(st.actionLog).toEqual([])
  })
  it('filing fails AFTER the send: the fax still counts as sent, ONE system error, the internal copy is kept, the reason is returned', async () => {
    st.saveThrows = true
    const r = await send({ save_choice: saveChoice() })
    expect(r.body.success).toBe(true); expect(r.body.saved).toBeNull(); expect(r.body.save_error).toMatch(/storage down/)
    expect(st.errors).toHaveLength(1); expect(st.bucketUploads).toHaveLength(1)
    expect((st.actionLog[0].details as Record<string, unknown>).save_error).toMatch(/storage down/)
  })
})

describe("/api/tools/fax/send — a personal form (SS-4) saved on purpose", () => {
  it('is filed where staff chose but listed against NO company', async () => {
    const r = await send({ save_choice: saveChoice({ purpose: 'irs_ein_request', fileName: 'SS-4 Acme' }), file_name: 'SS-4 Acme.pdf' })
    expect(r.body.success).toBe(true)
    expect(st.rows[0]).toMatchObject({ account_id: null, contact_id: null })
  })
})

describe('/api/tools/fax/send — the one-click EIN fax (a stored document) is unchanged', () => {
  it('sends the stored file; no pop-up choice is read, nothing is copied, History links the stored document', async () => {
    const r = await send({ document_id: 'stored-doc', file_base64: undefined, file_name: undefined, save_choice: saveChoice() })
    expect(r.body.success).toBe(true)
    expect(st.storeReads).toBe(1); expect(st.sendCalls).toBe(1)
    expect(st.saves).toEqual([]); expect(st.rows).toEqual([]); expect(st.bucketUploads).toEqual([]); expect(st.docInserts).toEqual([])
    expect(st.actionLog[0]).toMatchObject({ record_id: 'stored-doc' })
    expect((st.actionLog[0].details as Record<string, unknown>).save_choice).toBe('stored_document')
  })
})
