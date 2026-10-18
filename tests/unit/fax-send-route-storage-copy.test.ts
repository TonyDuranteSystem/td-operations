/**
 * The REAL /api/tools/fax/send route with the storage copy: the fax goes out whatever happens to the copy; a failed copy raises ONE
 * system error and keeps the old bucket copy; only a CERTAIN company is written to the activity log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const st = vi.hoisted(() => ({
  filed: null as unknown, throwOnFile: false, errors: [] as string[], actionLog: [] as Array<Record<string, unknown>>, bucketUploads: [] as string[], docInserts: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'luca@tonydurante.us' } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true }))
vi.mock('@/lib/google-drive', () => ({ downloadFileBinary: async () => { throw new Error('Drive must not be used') } }))
vi.mock('@/lib/fax/faxage', () => ({
  sendFax: async () => ({ ok: true, jobId: 'J1', raw: 'ok' }), isValidFaxNo: () => true, normalizeFaxNo: (x: string) => x, DEFAULT_IRS_FAX_NUMBER: '1', stripBase64Prefix: (x: string) => x,
}))
vi.mock('@/lib/fax/save-sent-upload', () => ({ fileSentUpload: async () => { if (st.throwOnFile) throw new Error('storage down'); return st.filed } }))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: async (e: { message: string }) => { st.errors.push(e.message) } }))
vi.mock('@/lib/supabase-admin', () => {
  const b = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle']) c[m] = () => c
    c.insert = (row: Record<string, unknown>) => { if (table === 'action_log') st.actionLog.push(row); if (table === 'documents') st.docInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: 'bucket-doc' } }) }), then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) } }
    c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r)
    return c
  }
  return { supabaseAdmin: { from: b, storage: { from: () => ({ upload: async (p: string) => { st.bucketUploads.push(p); return { error: null } }, createSignedUrl: async () => ({ data: { signedUrl: 'https://x' } }) }) } } }
})

process.env.FAXAGE_USERNAME = 'u'; process.env.FAXAGE_PASSWORD = 'p'
const send = async (extra: Record<string, unknown> = {}) => {
  const { POST } = await import('@/app/api/tools/fax/send/route')
  const res = await POST(new NextRequest('http://localhost/api/tools/fax/send', { method: 'POST', body: JSON.stringify({ faxno: '3055551212', file_base64: Buffer.from('%PDF').toString('base64'), file_name: '2025 Tax Return - Acme International LLC.pdf', ...extra }) }))
  return res
}

beforeEach(() => { st.filed = null; st.throwOnFile = false; st.errors.length = 0; st.actionLog.length = 0; st.bucketUploads.length = 0; st.docInserts.length = 0 })

describe('/api/tools/fax/send — the storage copy', () => {
  it('a named company: the copy is in storage (no bucket copy), the activity log names that company', async () => {
    st.filed = { route: 'store', accountId: 'acc-1', documentRowId: 'doc-1', inferred: false }
    const res = await send({ account_id: 'acc-1' })
    expect((await res.json()).success).toBe(true)
    expect(st.bucketUploads).toEqual([])
    expect(st.actionLog[0]).toMatchObject({ account_id: 'acc-1', record_id: 'doc-1' })
  })
  it('a company guessed from the file name: the copy is in storage, but the activity log does NOT name it', async () => {
    st.filed = { route: 'store', accountId: 'acc-9', documentRowId: 'doc-9', inferred: true }
    await send()
    expect(st.actionLog[0].account_id).toBeNull()
    expect((st.actionLog[0].details as Record<string, unknown>).company_inferred_from_file_name).toBe(true)
  })
  it('the storage copy throws: the fax still goes out, ONE system error, the old bucket copy is kept', async () => {
    st.throwOnFile = true
    const res = await send({ account_id: 'acc-1' })
    expect((await res.json()).success).toBe(true)
    expect(st.errors).toHaveLength(1)
    expect(st.bucketUploads).toHaveLength(1)
  })
  it('company moving: ONE system error and the old copy; a personal document: the old copy, no error', async () => {
    st.filed = { route: 'none', reason: 'company_moving' }
    await send({ account_id: 'acc-1' })
    expect(st.errors).toHaveLength(1); expect(st.bucketUploads).toHaveLength(1)
    st.errors.length = 0; st.bucketUploads.length = 0
    st.filed = { route: 'none', reason: 'personal_document' }
    await send({ account_id: 'acc-1' })
    expect(st.errors).toEqual([]); expect(st.bucketUploads).toHaveLength(1)
  })
})
