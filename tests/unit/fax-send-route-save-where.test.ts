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
  logsAtSend: [] as number[], sendCalls: 0, sendOk: true, sendThrows: false as boolean | 'sandbox', errors: [] as string[], actionLog: [] as Array<Record<string, unknown>>, bucketUploads: [] as string[], docInserts: [] as Array<Record<string, unknown>>,
  storeReads: 0,
  owners: {} as Record<string, unknown>, folders: {} as Record<string, unknown>, companyState: 'store' as string,
  files: new Map<string, { fileId: string; name: string }>(), rows: [] as Array<Record<string, unknown>>, saves: [] as string[], saveThrows: false, logsAtSave: [] as number[],
  logFail: { select: false, insert: false, update: 0, updateAll: false, insertRecordAfterClaim: false } as { select: boolean; insert: boolean; update: number; updateAll: boolean; insertRecordAfterClaim: boolean }, nextLogId: 1, signedUrls: 0, removed: [] as string[], staged: new Map<string, Buffer>(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true, isOwnerOnly: () => false }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => { throw new Error('Drive must not be used') } }))
vi.mock('@/lib/fax/faxage', () => ({
  sendFax: async () => { if (st.sendThrows === 'sandbox') { const e = new Error('Fax sending is blocked outside production'); e.name = 'FaxRefusedOutsideProductionError'; throw e } if (st.sendThrows) throw new Error('socket hang up'); st.logsAtSend.push(st.actionLog.length); st.sendCalls++; return st.sendOk ? { ok: true, jobId: 'J1', raw: 'ok' } : { ok: false, jobId: null, raw: 'ERR99 bad' } },
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
      st.logsAtSave.push(st.actionLog.length)
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
  const getCol = (row: Record<string, unknown>, col: string): unknown => {
    if (col.startsWith('details->>')) return (row.details as Record<string, unknown> | undefined)?.[col.slice(10)]
    return row[col]
  }
  const b = (table: string) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let mode: 'select' | 'delete' | 'update' | 'insert' = 'select'
    let patch: Record<string, unknown> = {}
    let single = false
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.order = () => c; c.limit = () => c
    c.single = () => { single = true; return c }
    c.maybeSingle = () => { single = true; return c }
    c.eq = (col: string, val: unknown) => { filters.push((r) => String(getCol(r, col)) === String(val)); return c }
    c.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(getCol(r, col))); return c }
    c.gte = () => c
    c.delete = () => { mode = 'delete'; return c }
    c.update = (p: Record<string, unknown>) => { mode = 'update'; patch = p; return c }
    c.insert = (row: Record<string, unknown>) => {
      mode = 'insert'
      if (table === 'documents') { st.docInserts.push(row) }
      if (table === 'action_log') {
        if (st.logFail.insert || (st.logFail.insertRecordAfterClaim && row.action_type === 'fax_sent')) { c.__insertError = true; return c }
        const r = { ...row, id: `log-${st.nextLogId++}`, created_at: '2026-10-20T10:00:00Z' }
        st.actionLog.push(r); c.__inserted = r
      } else c.__inserted = { id: 'bucket-doc' }
      return c
    }
    c.then = (resolve: (v: unknown) => unknown) => {
      let out: { data: unknown; error: unknown } = { data: null, error: null }
      if (table === 'action_log') {
        if (mode === 'insert') out = c.__insertError ? { data: null, error: { message: 'insert failed' } } : { data: c.__inserted, error: null }
        else if (mode === 'select') {
          if (st.logFail.select) out = { data: null, error: { message: 'select failed' } }
          else { const rows = st.actionLog.filter((r) => filters.every((f) => f(r))); out = { data: single ? (rows[0] ?? null) : rows, error: null } }
        } else if (mode === 'delete') { const k = st.actionLog.findIndex((r) => filters.every((f) => f(r))); if (k >= 0) st.actionLog.splice(k, 1) }
        else if (mode === 'update') {
          if (st.logFail.updateAll || st.logFail.update > 0) { if (st.logFail.update > 0) st.logFail.update--; out = { data: null, error: { message: 'update failed' } } }
          else { const row = st.actionLog.find((r) => filters.every((f) => f(r))); if (row) Object.assign(row, patch) }
        }
      } else if (table === 'documents') {
        out = mode === 'insert' ? { data: c.__inserted, error: null } : { data: { id: 'stored-doc', file_name: 'SS-4 package.pdf', drive_file_id: 'store:sf-1', account_id: 'acc-1' }, error: null }
      } else if (mode === 'insert') out = { data: c.__inserted, error: null }
      return Promise.resolve(out).then(resolve)
    }
    return c
  }
  return { supabaseAdmin: { from: b, storage: { from: () => ({
    upload: async (p: string) => { st.bucketUploads.push(p); return { error: null } },
    createSignedUrl: async () => { st.signedUrls++; return { data: { signedUrl: 'https://x' } } },
    download: async (p: string) => { const buf = st.staged.get(p); return buf ? { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null } : { data: null, error: { message: 'missing' } } },
    remove: async (paths: string[]) => { st.removed.push(...paths); return { data: null, error: null } },
  }) } } }
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
  st.sendCalls = 0; st.logsAtSend.length = 0; st.sendOk = true; st.sendThrows = false; st.errors.length = 0; st.actionLog.length = 0; st.bucketUploads.length = 0; st.docInserts.length = 0; st.storeReads = 0
  st.companyState = 'store'; st.files.clear(); st.rows.length = 0; st.saves.length = 0; st.saveThrows = false; st.logsAtSave.length = 0; st.logFail = { select: false, insert: false, update: 0, updateAll: false, insertRecordAfterClaim: false }; st.nextLogId = 1; st.signedUrls = 0; st.removed.length = 0; st.staged.clear()
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
    await send({ save_choice: saveChoice(), confirm_resend: true })
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
  it("an SS-4 / 1040 keeps its internal copy but it is attached to NO company; a company paper's copy neither (a forged account_id is ignored)", async () => {
    await send({ save_choice: { mode: 'dont_save' }, file_name: 'SS-4_Rossi_Signed_for_IRS.pdf', account_id: 'acc-1' })
    expect(st.docInserts[0].account_id).toBeNull()
    st.docInserts.length = 0
    await send({ save_choice: { mode: 'dont_save' }, file_name: '2025 Tax Return.pdf', account_id: 'acc-victim', confirm_resend: true })
    expect(st.docInserts[0].account_id).toBeNull()
    expect(st.actionLog[st.actionLog.length - 1].account_id).toBeNull()
  })
  it("an identity paper gets NO internal copy at all (no row, no link), whatever was chosen", async () => {
    const r = await send({ save_choice: { mode: 'dont_save' }, file_name: 'Passport_Rossi.pdf' })
    expect(r.body.success).toBe(true); expect(r.body.no_copy_reason).toBe('personal_paper')
    expect(st.bucketUploads).toEqual([]); expect(st.docInserts).toEqual([])
    expect(st.actionLog[0].record_id).toBeNull()
    expect((st.actionLog[0].details as Record<string, unknown>).no_copy_reason).toBe('personal_paper')
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

const SEND_ID = 'send-0001-aaaa-bbbb'
describe('/api/tools/fax/send — the fax is on record BEFORE the filing, and one Send is one fax', () => {
  it('the activity record exists when the filing starts, and is completed afterwards', async () => {
    await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(st.logsAtSave).toEqual([1])
    expect(st.actionLog).toHaveLength(1)
    expect(st.actionLog[0].details).toMatchObject({ send_id: SEND_ID, filing_status: 'done', saved_at_place: 'Acme › 3. Tax › 2025' })
    expect(st.actionLog[0].record_id).toBe('row-1')
  })
  it('the filing fails (or the request dies) AFTER the fax went out: a second Send with the same send_id is REFUSED, the fax is not sent twice', async () => {
    st.saveThrows = true
    const first = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(first.body).toMatchObject({ success: true, fax_sent: true, save_failed: true })
    expect(first.body.save_error).toMatch(/storage down/)
    expect(st.actionLog[0].details).toMatchObject({ filing_status: 'failed' })
    st.saveThrows = false
    const second = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(second.status).toBe(409); expect(second.body.success).toBe(false)
    expect(second.body.error).toMatch(/WAS already sent/); expect(second.body.already_sent).toMatchObject({ job_id: 'J1' })
    expect(st.sendCalls).toBe(1); expect(st.saves).toEqual([])
  })
  it('a fax Faxage REFUSED leaves no record, so the same send_id can be tried again', async () => {
    st.sendOk = false
    expect((await send({ save_choice: saveChoice(), send_id: SEND_ID })).status).toBe(502)
    expect(st.actionLog).toEqual([])
    st.sendOk = true
    expect((await send({ save_choice: saveChoice(), send_id: SEND_ID })).body.success).toBe(true)
  })
  it('a different send_id (a new fax) is not blocked', async () => {
    await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect((await send({ save_choice: saveChoice(), send_id: 'send-0002-cccc-dddd', confirm_resend: true })).body.success).toBe(true)
    expect(st.sendCalls).toBe(2)
  })
})

describe('/api/tools/fax/send — privacy of what staff put in a private place', () => {
  const MY = U(8), MYTOP = U(9), MYFOLDER = U(10)
  beforeEach(() => {
    st.owners[MY] = { id: MY, kind: 'private', study_only: false, account_id: null, contact_id: null, service_delivery_id: null }
    st.folders[MYFOLDER] = { id: MYFOLDER, owner_id: MY, kind: 'custom', trashed_at: null }
    st.folders[MYTOP] = { id: MYTOP, owner_id: MY, kind: 'root', trashed_at: null }
  })
  it('My files: filed there, but NO internal copy (no row, no signed link) — Fax History says so', async () => {
    const r = await send({ save_choice: saveChoice({ purpose: 'something_else', ownerId: MY, folderId: MYFOLDER }) })
    expect(r.body).toMatchObject({ success: true, no_copy_reason: 'my_files' })
    expect(st.saves).toHaveLength(1)
    expect(st.bucketUploads).toEqual([]); expect(st.docInserts).toEqual([])
    expect(st.actionLog[0].record_id).toBeNull()
    expect((st.actionLog[0].details as Record<string, unknown>).no_copy_reason).toBe('my_files')
  })
  it('My files and the filing FAILS: still no internal copy (the choice was private)', async () => {
    st.saveThrows = true
    const r = await send({ save_choice: saveChoice({ purpose: 'something_else', ownerId: MY, folderId: MYFOLDER }) })
    expect(r.body.save_failed).toBe(true); expect(st.bucketUploads).toEqual([])
  })
  it('a company id forged in the body is ignored when the file is filed: the activity record names the place staff chose', async () => {
    await send({ save_choice: saveChoice(), account_id: 'acc-victim' })
    expect(st.actionLog[0].account_id).toBe('acc-1')
    expect(st.rows[0].account_id).toBe('acc-1')
  })
})

describe('/api/tools/fax/send — ONE fax per Send (claim before Faxage)', () => {
  it('the claim row is ALREADY in the log when Faxage is called, and it becomes the history row', async () => {
    await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(st.logsAtSend).toEqual([1])
    expect(st.actionLog).toHaveLength(1); expect(st.actionLog[0].action_type).toBe('fax_sent')
  })
  it('a lookup error STOPS the send (503, "NOT sent"), nothing is sent or filed', async () => {
    st.logFail.select = true
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.status).toBe(503); expect(r.body.error).toMatch(/NOT sent/)
    expect(st.sendCalls).toBe(0); expect(st.saves).toEqual([])
  })
  it('the claim cannot be written: 503, NOT sent', async () => {
    st.logFail.insert = true
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.status).toBe(503); expect(st.sendCalls).toBe(0)
  })
  it('a retry with the same send_id while the first is unfinished is stopped (in progress), the same file to the same number from a reloaded page needs a confirm', async () => {
    st.actionLog.push({ id: 'old', action_type: 'fax_claim', created_at: 't', details: { send_id: SEND_ID, faxno: '3055551212', content_hash: 'x' } })
    const a = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(a.status).toBe(409); expect(a.body.in_progress).toBe(true); expect(st.sendCalls).toBe(0)
    st.actionLog.length = 0
    expect((await send({ save_choice: saveChoice(), send_id: 'send-0009-zzzz-yyyy' })).body.success).toBe(true)
    const again = await send({ save_choice: saveChoice(), send_id: 'send-0010-zzzz-yyyy' })
    expect(again.status).toBe(409); expect(again.body.recent_duplicate).toBe(true); expect(again.body.already_faxed).toMatchObject({ job_id: 'J1' })
    expect(st.sendCalls).toBe(1)
  })
  it('a fax whose outcome is UNKNOWN (network error) keeps its claim, so a retry is stopped', async () => {
    st.sendThrows = true
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.status).toBe(502); expect(r.body.error).toMatch(/not known whether the fax went out/)
    expect(st.actionLog).toHaveLength(1); expect(st.actionLog[0].action_type).toBe('fax_claim')
    st.sendThrows = false
    expect((await send({ save_choice: saveChoice(), send_id: SEND_ID })).status).toBe(409)
  })
  it('the sandbox refusal (never reached the network) releases the claim', async () => {
    st.sendThrows = 'sandbox'
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.status).toBe(502); expect(st.actionLog).toEqual([])
  })
})

describe('/api/tools/fax/send — the history of a fax that WAS sent is never lost silently', () => {
  it('one failed update is retried; the row ends as fax_sent', async () => {
    st.logFail.update = 1
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.body.success).toBe(true); expect(r.body.history_error).toBeNull()
    expect(st.actionLog.filter((x) => x.action_type === 'fax_sent')).toHaveLength(1)
  })
  it('the history cannot be written at all: the answer says the fax WAS sent and the entry was not saved, and ONE alarm per failure is raised', async () => {
    st.logFail.updateAll = true; st.logFail.insertRecordAfterClaim = true
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.body).toMatchObject({ success: true, fax_sent: true })
    expect(r.body.history_error).toMatch(/WAS sent, but its history entry could not be saved/)
    expect(st.errors.some((e) => /history entry could not be saved/.test(e))).toBe(true)
    expect(st.sendCalls).toBe(1)
  })
  it('the update keeps failing but a fresh insert works: the row exists', async () => {
    st.logFail.updateAll = true
    const r = await send({ save_choice: saveChoice(), send_id: SEND_ID })
    expect(r.body.history_error).toBeNull()
    expect(st.actionLog.some((x) => x.action_type === 'fax_sent')).toBe(true)
  })
  it('the flow double-send guard fails CLOSED on a lookup error', async () => {
    st.logFail.select = true
    const r = await send({ save_choice: saveChoice(), dedupe_service_delivery_id: 'sd-1' })
    expect(r.status).toBe(503); expect(st.sendCalls).toBe(0)
  })
})

describe('/api/tools/fax/send — copies and sources', () => {
  it('no 1-year signed link is ever made for the internal copy', async () => {
    await send({ save_choice: { mode: 'dont_save' } })
    expect(st.bucketUploads).toHaveLength(1); expect(st.signedUrls).toBe(0)
    expect(String(st.docInserts[0].drive_link)).toMatch(/^onboarding-uploads\/fax-attachments\//)
  })
  it('an SS-4 saved on purpose whose filing FAILS gets no internal copy either', async () => {
    st.saveThrows = true
    const r = await send({ save_choice: saveChoice({ purpose: 'irs_ein_request', fileName: 'SS-4 Acme' }), file_name: 'SS-4_Acme_Signed_for_IRS.pdf' })
    expect(r.body).toMatchObject({ save_failed: true, no_copy_reason: 'personal_paper' })
    expect(st.bucketUploads).toEqual([]); expect(st.docInserts).toEqual([])
  })
  it('"Fax this file" (already_stored): sent from the bytes, NOTHING is copied (no bucket row of a possibly staff-only file), the history says so', async () => {
    const r = await send({ already_stored: true, file_name: 'Staff only.pdf', save_choice: saveChoice() })
    expect(r.body.success).toBe(true)
    expect(st.bucketUploads).toEqual([]); expect(st.docInserts).toEqual([]); expect(st.saves).toEqual([])
    expect((st.actionLog[0].details as Record<string, unknown>).source).toBe('stored_file')
    expect((st.actionLog[0].details as Record<string, unknown>).save_choice).toBe('stored_document')
  })
  it('a big upload staged by the browser is read here, removed at once, and filed like any upload', async () => {
    const path = 'fax-upload/123e4567-e89b-12d3-a456-426614174000.pdf'
    st.staged.set(path, Buffer.from('%PDF big'))
    const r = await send({ file_base64: undefined, staged_path: path, save_choice: saveChoice() })
    expect(r.body.success).toBe(true); expect(st.removed).toContain(path); expect(st.saves).toHaveLength(1)
  })
  it('a staged path of another shape is refused', async () => {
    for (const bad of ['../secret', 'fax-upload/../x.pdf', 'other/123e4567-e89b-12d3-a456-426614174000.pdf']) {
      const r = await send({ file_base64: undefined, staged_path: bad, save_choice: saveChoice() })
      expect(r.status).toBe(400)
    }
    expect(st.sendCalls).toBe(0)
  })
})
