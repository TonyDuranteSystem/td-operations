import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: () => getUser() } }) }))

const T = {
  createDraft: vi.fn(), getApproved: vi.fn(), getOpenDraft: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), getVersion: vi.fn(), approveDraft: vi.fn(),
}
vi.mock('@/lib/contracts/service-contract-texts', async (orig) => {
  const real = await orig<typeof import('@/lib/contracts/service-contract-texts')>()
  return { ...real, createDraft: (...a: unknown[]) => T.createDraft(...a), getApproved: (...a: unknown[]) => T.getApproved(...a), getOpenDraft: (...a: unknown[]) => T.getOpenDraft(...a), saveDraft: (...a: unknown[]) => T.saveDraft(...a), discardDraft: (...a: unknown[]) => T.discardDraft(...a), getVersion: (...a: unknown[]) => T.getVersion(...a), approveDraft: (...a: unknown[]) => T.approveDraft(...a) }
})
const loadContractView = vi.fn()
const loadServiceFacts = vi.fn()
vi.mock('@/lib/contracts/service-contract-view', async (orig) => ({ ...(await orig<typeof import('@/lib/contracts/service-contract-view')>()), loadContractView: (...a: unknown[]) => loadContractView(...a), loadServiceFacts: (...a: unknown[]) => loadServiceFacts(...a) }))
const draftWording = vi.fn()
const reviseWording = vi.fn()
vi.mock('@/lib/contracts/draft-with-claude', () => ({ draftWording: (...a: unknown[]) => draftWording(...a), reviseWording: (...a: unknown[]) => reviseWording(...a) }))
const getEntryById = vi.fn()
vi.mock('@/lib/catalog/framework', () => ({ getEntryById: (...a: unknown[]) => getEntryById(...a) }))

import { ContractTextError } from '@/lib/contracts/service-contract-texts'
import { GET as getOne } from '@/app/api/service-contracts/[entryId]/route'
import { POST as postDraft } from '@/app/api/service-contracts/[entryId]/draft/route'
import { PUT as putVersion, DELETE as deleteVersion } from '@/app/api/service-contracts/versions/[id]/route'
import { POST as postAsk } from '@/app/api/service-contracts/versions/[id]/ask/route'
import { POST as postApprove } from '@/app/api/service-contracts/versions/[id]/approve/route'

const owner = { id: 'u1', email: 'Antonio.Durante@tonydurante.us', app_metadata: { role: 'admin' } }
const staffAdmin = { id: 'u2', email: 'someone.else@tonydurante.us', app_metadata: { role: 'admin' } }
const client = { id: 'u3', email: 'c@x.com', app_metadata: { role: 'client' } }
const wording = {
  title: 'Apostille Service Agreement', shortTitle: 'Apostille Service Agreement', pdfPrefix: 'Apostille_Agreement',
  scope: { intro: 'Intro:', items: ['A;'], closing: 'Only one.' },
  procedure: { intro: 'Steps:', steps: [{ title: 'S', desc: 'D' }] },
  commitments: ['C.'], clientDuties: { intro: 'The Client agrees to:', items: [{ bold: 'B', rest: ' r.' }] },
  signatureText: 'I agree.', successNote: 'Done.', workPhrase: 'the apostille', liabilityPhrase: 'delays',
}
const req = (body?: unknown) => ({ json: async () => body ?? {} }) as unknown as Request
const rowOf = (o: Record<string, unknown> = {}) => ({ id: 'v1', service_entry_id: 'e1', contract_type: 'custom_apostille', version: 1, status: 'draft', content: wording, content_hash: 'h1', source: 'manual', note: null, created_by: 'x', created_at: 't', approved_by: null, approved_at: null, superseded_at: null, ...o })
const newEntry = { id: 'e1', catalog_id: 'services', metadata: { pipeline: 'Apostille' } }

beforeEach(() => {
  getUser.mockReset(); getUser.mockResolvedValue({ data: { user: staffAdmin } })
  Object.values(T).forEach((f) => f.mockReset()); loadContractView.mockReset(); loadServiceFacts.mockReset(); draftWording.mockReset(); reviseWording.mockReset(); getEntryById.mockReset()
  getEntryById.mockResolvedValue(newEntry); T.getOpenDraft.mockResolvedValue(null)
})
const as = (u: unknown) => getUser.mockResolvedValue({ data: { user: u } })

describe('every route needs an admin', () => {
  it('refuses a client and a signed-out visitor', async () => {
    for (const u of [client, null]) {
      as(u)
      expect((await getOne(req(), { params: { entryId: 'e1' } })).status).toBe(403)
      expect((await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })).status).toBe(403)
      expect((await putVersion(req({ content: wording }), { params: { id: 'v1' } })).status).toBe(403)
      expect((await deleteVersion(req(), { params: { id: 'v1' } })).status).toBe(403)
      expect((await postAsk(req({ request: 'x' }), { params: { id: 'v1' } })).status).toBe(403)
      expect((await postApprove(req({ expectedHash: 'h' }), { params: { id: 'v1' } })).status).toBe(403)
    }
    expect(T.createDraft).not.toHaveBeenCalled(); expect(T.approveDraft).not.toHaveBeenCalled()
  })
})

describe('GET — who may approve', () => {
  it('tells the screen whether this person is an owner', async () => {
    loadContractView.mockResolvedValue({ service: {}, kind: 'new', state: 'none', versions: [] })
    expect((await (await getOne(req(), { params: { entryId: 'e1' } })).json()).viewer.canApprove).toBe(false)
    as(owner)
    const j = await (await getOne(req(), { params: { entryId: 'e1' } })).json()
    expect(j.viewer).toEqual({ canApprove: true, name: 'Antonio Durante' })
  })
  it('a missing service is a 404 with the real reason', async () => {
    loadContractView.mockRejectedValue(new ContractTextError('NOT_FOUND', 'That service does not exist.'))
    const res = await getOne(req(), { params: { entryId: 'e1' } })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('That service does not exist.')
  })
  it('a database without the migration answers 503 in plain words', async () => {
    loadContractView.mockRejectedValue(new ContractTextError('NOT_READY', 'Contracts for new services are not switched on yet.'))
    expect((await getOne(req(), { params: { entryId: 'e1' } })).status).toBe(503)
  })
})

describe('POST draft', () => {
  it('Claude mode saves the draft as written by Claude, by this person', async () => {
    loadServiceFacts.mockResolvedValue({ name: 'Apostille' })
    draftWording.mockResolvedValue({ ok: true, wording, model: 'm' })
    T.createDraft.mockResolvedValue(rowOf({ source: 'claude_draft' }))
    const res = await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })
    expect(res.status).toBe(200)
    expect(T.createDraft).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'e1', source: 'claude_draft', createdBy: 'someone.else@tonydurante.us', content: wording }))
  })
  it('Claude failing saves nothing and says why', async () => {
    loadServiceFacts.mockResolvedValue({})
    draftWording.mockResolvedValue({ ok: false, error: 'Claude took too long to answer. Try again.' })
    const res = await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('too long')
    expect(T.createDraft).not.toHaveBeenCalled()
  })
  it('refuses a built-in contract and an existing open draft BEFORE spending a Claude call', async () => {
    getEntryById.mockResolvedValue({ ...newEntry, metadata: { pipeline: 'Shipping', contract_type: 'shipping' } })
    expect((await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })).status).toBe(409)
    // an ORIGINAL service (EIN, DBA, …) is refused too, with the reason — giving it a contract type would change every offer containing it
    getEntryById.mockResolvedValue({ ...newEntry, metadata: { pipeline: 'EIN' } })
    const legacy = await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })
    expect(legacy.status).toBe(409)
    expect((await legacy.json()).error).toMatch(/original services/)
    getEntryById.mockResolvedValue(newEntry); T.getOpenDraft.mockResolvedValue(rowOf())
    expect((await postDraft(req({ mode: 'claude' }), { params: { entryId: 'e1' } })).status).toBe(409)
    expect(draftWording).not.toHaveBeenCalled()
  })
  it('a new version starts as a copy of the approved wording', async () => {
    T.getApproved.mockResolvedValue(rowOf({ id: 'a', version: 3, status: 'approved' }))
    T.createDraft.mockResolvedValue(rowOf({ version: 4 }))
    expect((await postDraft(req({ mode: 'from_approved' }), { params: { entryId: 'e1' } })).status).toBe(200)
    expect(T.createDraft).toHaveBeenCalledWith(expect.objectContaining({ content: wording, source: 'manual', note: 'Started from version 3' }))
    T.getApproved.mockResolvedValue(null)
    expect((await postDraft(req({ mode: 'from_approved' }), { params: { entryId: 'e1' } })).status).toBe(404)
  })
  it('an unknown mode is a 400', async () => {
    expect((await postDraft(req({ mode: 'x' }), { params: { entryId: 'e1' } })).status).toBe(400)
  })
})

describe('PUT (edit a draft)', () => {
  it('invalid wording comes back 422 with the problems keyed by line, and nothing is saved', async () => {
    const bad = { ...wording, scope: { ...wording.scope, items: ['ok', '<b>x</b>'] } }
    const res = await putVersion(req({ content: bad, expectedHash: 'h1' }), { params: { id: 'v1' } })
    expect(res.status).toBe(422)
    const j = await res.json()
    expect(Object.keys(j.fields)).toEqual(['scope.items.1'])
    expect(T.saveDraft).not.toHaveBeenCalled()
  })
  it('saves valid wording as a hand edit, against the version that was read', async () => {
    T.saveDraft.mockResolvedValue(rowOf({ content_hash: 'h2' }))
    const res = await putVersion(req({ content: wording, expectedHash: 'h1' }), { params: { id: 'v1' } })
    expect(res.status).toBe(200)
    expect(T.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1', source: 'manual', expectedHash: 'h1' }))
    expect((await res.json()).version.hash).toBe('h2')
  })
  it('a draft changed elsewhere is a 409', async () => {
    T.saveDraft.mockRejectedValue(new ContractTextError('DRAFT_CHANGED', 'changed somewhere else'))
    expect((await putVersion(req({ content: wording, expectedHash: 'old' }), { params: { id: 'v1' } })).status).toBe(409)
  })
})

describe('DELETE (throw away a draft)', () => {
  it('discards a draft but never an approved version', async () => {
    T.getVersion.mockResolvedValue(rowOf({ status: 'approved' }))
    expect((await deleteVersion(req(), { params: { id: 'v1' } })).status).toBe(409)
    expect(T.discardDraft).not.toHaveBeenCalled()
    T.getVersion.mockResolvedValue(rowOf())
    T.discardDraft.mockResolvedValue(true)
    expect((await deleteVersion(req(), { params: { id: 'v1' } })).status).toBe(200)
    expect(T.discardDraft).toHaveBeenCalledWith('v1')
  })
  it('an owner approving the draft in the same moment is NOT reported as "thrown away"', async () => {
    T.getVersion.mockResolvedValueOnce(rowOf()).mockResolvedValueOnce(rowOf({ status: 'approved' }))
    T.discardDraft.mockResolvedValue(false)
    const res = await deleteVersion(req(), { params: { id: 'v1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/approved just now/)
  })
})

describe('POST ask (Claude changes the draft)', () => {
  it('needs a request and an open draft', async () => {
    expect((await postAsk(req({ request: '  ' }), { params: { id: 'v1' } })).status).toBe(400)
    T.getVersion.mockResolvedValue(rowOf({ status: 'approved' }))
    expect((await postAsk(req({ request: 'x' }), { params: { id: 'v1' } })).status).toBe(409)
    expect(reviseWording).not.toHaveBeenCalled()
  })
  it('saves Claude’s change against the version it started from, remembering the request', async () => {
    T.getVersion.mockResolvedValue(rowOf())
    loadServiceFacts.mockResolvedValue({})
    reviseWording.mockResolvedValue({ ok: true, wording: { ...wording, title: 'Changed' }, model: 'm' })
    T.saveDraft.mockResolvedValue(rowOf({ source: 'claude_change' }))
    const res = await postAsk(req({ request: 'Shorten the scope' }), { params: { id: 'v1' } })
    expect(res.status).toBe(200)
    expect(T.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1', source: 'claude_change', note: 'Shorten the scope', expectedHash: 'h1' }))
  })
  it('a failed Claude call leaves the draft exactly as it was', async () => {
    T.getVersion.mockResolvedValue(rowOf()); loadServiceFacts.mockResolvedValue({})
    reviseWording.mockResolvedValue({ ok: false, error: 'Claude could not be reached' })
    expect((await postAsk(req({ request: 'x' }), { params: { id: 'v1' } })).status).toBe(502)
    expect(T.saveDraft).not.toHaveBeenCalled()
  })
})

describe('POST approve — owners only, bound to the wording that was read', () => {
  beforeEach(() => { T.getVersion.mockResolvedValue(rowOf()) })
  it('an admin who is not an owner is refused and nothing is approved', async () => {
    const res = await postApprove(req({ expectedHash: 'h1' }), { params: { id: 'v1' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Only an owner can approve a contract.')
    expect(T.approveDraft).not.toHaveBeenCalled()
  })
  it('an owner approves exactly the fingerprint they read, recorded under their email', async () => {
    as(owner)
    T.approveDraft.mockResolvedValue(rowOf({ status: 'approved', approved_by: 'antonio.durante@tonydurante.us' }))
    const res = await postApprove(req({ expectedHash: 'h1' }), { params: { id: 'v1' } })
    expect(res.status).toBe(200)
    expect(T.approveDraft).toHaveBeenCalledWith({ id: 'v1', expectedHash: 'h1', approvedBy: 'antonio.durante@tonydurante.us' })
  })
  it('wording the client page could not show is NEVER approved (the database cannot check this, so the route does)', async () => {
    as(owner)
    T.getVersion.mockResolvedValue(rowOf({ content: { ...wording, successNote: '<script>x</script>' } }))
    const res = await postApprove(req({ expectedHash: 'h1' }), { params: { id: 'v1' } })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/cannot be approved because its wording is not valid/)
    expect(T.approveDraft).not.toHaveBeenCalled()
  })
  it('a version that no longer exists is a 404', async () => {
    as(owner)
    T.getVersion.mockResolvedValue(null)
    expect((await postApprove(req({ expectedHash: 'h1' }), { params: { id: 'v1' } })).status).toBe(404)
    expect(T.approveDraft).not.toHaveBeenCalled()
  })
  it('needs the fingerprint; a changed draft is a 409', async () => {
    as(owner)
    expect((await postApprove(req({}), { params: { id: 'v1' } })).status).toBe(400)
    T.approveDraft.mockRejectedValue(new ContractTextError('DRAFT_CHANGED', 'The wording changed after you read it'))
    const res = await postApprove(req({ expectedHash: 'old' }), { params: { id: 'v1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('changed after you read it')
  })
})
