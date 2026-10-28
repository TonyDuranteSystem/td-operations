/**
 * Dev job e3215801 — the two server routes: the read-only check the Storage page asks BEFORE a file is saved, and the backstop inside the
 * upload route (a file a workspace step is waiting for is refused unless the staff member chose "Save in Storage only").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const fx = vi.hoisted(() => ({
  staff: true,
  hits: [] as Array<Record<string, unknown>>,
  finderThrows: false,
  finderCalls: [] as Array<Record<string, unknown>>,
  saved: [] as Array<Record<string, unknown>>,
  saveThrows: false,
  logs: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
}))

vi.mock('@/app/api/crm-store/browse/_auth', () => ({
  denyUnlessStoreStaff: async () => (fx.staff ? null : NextResponse.json({ error: 'Staff only' }, { status: 403 })),
  denyUnlessStorePilotEnv: async () => null,
  denyUnlessAreaAccess: async () => null,
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'luca@tonydurante.us' } } }) } }) }))
vi.mock('@/lib/flows/storage-step-hints', () => ({
  findWaitingWorkspaceSteps: async (input: Record<string, unknown>) => {
    fx.finderCalls.push(input)
    if (fx.finderThrows) throw new Error('boom')
    return fx.hits
  },
}))
vi.mock('@/lib/crm-store/browse', () => ({
  STAFF_STORE_UPLOAD_PREFIX: 'crm-uploads/store-staging/',
  staffUploadToStore: async (p: Record<string, unknown>) => {
    if (fx.saveThrows) throw new Error('no space')
    fx.saved.push(p)
    return { fileId: 'file-1', write: 'created', name: String(p.fileName), visible: false }
  },
}))
vi.mock('@/lib/crm-store/lock-errors', () => ({ plainStoreError: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({ insert: (row: Record<string, unknown>) => { if (table === 'action_log') fx.logs.push(row); return Promise.resolve({ error: null }) }, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { kind: 'person' } }) }) }) }),
    storage: { from: () => ({ remove: async (paths: string[]) => { fx.removed.push(...paths); return { data: null, error: null } } }) },
  },
}))

import { POST as check } from '@/app/api/crm-store/browse/workspace-check/route'
import { POST as upload } from '@/app/api/crm-store/browse/upload/route'

const HIT = { sdId: 'sd-1', serviceType: 'ITIN', stage: 'IRS Processing', who: 'Adam Mihaly', asks: 'the IRS approval letter (CP565)', workspaceDoes: ['close the case'], workspacePath: '/flows/sd-1' }
const req = (path: string, body: Record<string, unknown>) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) })
const UP = { ownerId: 'o-1', folderId: 'f-1', storagePath: 'crm-uploads/store-staging/o-1/1_abc_letter.pdf', fileName: 'letter.pdf', mimeType: 'application/pdf', documentType: 'itin_letter' }

beforeEach(() => {
  fx.staff = true
  fx.hits = []
  fx.finderThrows = false
  fx.finderCalls = []
  fx.saved = []
  fx.saveThrows = false
  fx.logs = []
  fx.removed = []
})

describe('POST /api/crm-store/browse/workspace-check', () => {
  it('staff only', async () => {
    fx.staff = false
    expect((await check(req('/x', { ownerId: 'o-1' }))).status).toBe(403)
  })
  it('needs an owner', async () => {
    expect((await check(req('/x', {}))).status).toBe(400)
  })
  it('answers the hits, passing the folder, type and person through', async () => {
    fx.hits = [HIT]
    const res = await check(req('/x', { ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter', personContactId: 'c-1' }))
    expect(res.status).toBe(200)
    expect((await res.json()).hits).toEqual([HIT])
    expect(fx.finderCalls[0]).toEqual({ ownerId: 'o-1', folderId: 'f-1', documentType: 'itin_letter', personContactId: 'c-1' })
  })
  it('nothing waiting -> an empty list', async () => {
    expect((await (await check(req('/x', { ownerId: 'o-1', documentType: 'passport' }))).json()).hits).toEqual([])
  })
  it('a check that cannot be completed is a 503 "nothing was saved" — never an empty pass', async () => {
    fx.finderThrows = true
    const res = await check(req('/x', { ownerId: 'o-1', documentType: 'itin_letter' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('nothing was saved')
  })
})

describe('POST /api/crm-store/browse/upload — the backstop', () => {
  it('no step waiting -> saved as before, nothing logged', async () => {
    const res = await upload(req('/x', { ...UP, documentType: 'passport' }))
    expect(res.status).toBe(200)
    expect(fx.saved).toHaveLength(1)
    expect(fx.logs).toHaveLength(0)
  })

  it('A STEP IS WAITING and the caller did not answer -> 409, nothing saved, the staged file is removed, the reason is plain', async () => {
    fx.hits = [HIT]
    const res = await upload(req('/x', UP))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('workspace_step_waiting')
    expect(body.error).toContain("Adam Mihaly's ITIN case is at \"IRS Processing\"")
    expect(body.error).toContain('nothing was saved')
    expect(body.hits).toHaveLength(1)
    expect(fx.saved).toHaveLength(0)
    expect(fx.removed).toEqual([UP.storagePath])
  })

  it('"Save in Storage only" (the case is acknowledged) -> saved, AND the case\'s record says it was filed in Storage only', async () => {
    fx.hits = [HIT]
    const res = await upload(req('/x', { ...UP, workspaceAck: ['sd-1'] }))
    expect(res.status).toBe(200)
    expect(fx.saved).toHaveLength(1)
    expect(fx.logs).toHaveLength(1)
    expect(fx.logs[0]).toMatchObject({ action_type: 'storage_filed_workspace_document', service_delivery_id: 'sd-1', record_id: 'file-1', actor: 'dashboard:luca' })
    expect(String(fx.logs[0].summary)).toContain('filed in Storage only')
    expect(String(fx.logs[0].summary)).toContain('the workspace step was not done')
  })

  it('an answer for ANOTHER case does not cover this one', async () => {
    fx.hits = [HIT]
    const res = await upload(req('/x', { ...UP, workspaceAck: ['some-other-case'] }))
    expect(res.status).toBe(409)
    expect(fx.saved).toHaveLength(0)
  })

  it('a malformed answer is ignored (it is not a pass)', async () => {
    fx.hits = [HIT]
    expect((await upload(req('/x', { ...UP, workspaceAck: 'sd-1' }))).status).toBe(409)
    expect((await upload(req('/x', { ...UP, workspaceAck: [1, null, {}] }))).status).toBe(409)
  })

  it('FAILS CLOSED: a check that cannot be completed saves nothing (503) and the staged file is removed', async () => {
    fx.finderThrows = true
    const res = await upload(req('/x', UP))
    expect(res.status).toBe(503)
    expect(fx.saved).toHaveLength(0)
    expect(fx.removed).toEqual([UP.storagePath])
  })

  it('a save that fails after the answer writes no record', async () => {
    fx.hits = [HIT]
    fx.saveThrows = true
    const res = await upload(req('/x', { ...UP, workspaceAck: ['sd-1'] }))
    expect(res.status).toBe(400)
    expect(fx.logs).toHaveLength(0)
  })

  it('the person chosen in "2. Contacts" is passed to the check', async () => {
    await upload(req('/x', { ...UP, personContactId: 'c-9' }))
    expect(fx.finderCalls[0]).toMatchObject({ personContactId: 'c-9', documentType: 'itin_letter' })
  })
})
