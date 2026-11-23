/**
 * Handler tests for two team routes that had NO test of their own (dev job e59dd470, 20 Nov hunt D#15):
 *   POST /api/portal/team/accept-notice        — a team login accepts its OWN notice
 *   POST /api/portal/team/[id]/personal-docs   — an owner / member shares (or stops sharing) THEIR OWN personal papers with one login
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertAdmin: vi.fn(),
  accept: vi.fn(),
  setShare: vi.fn(),
  checkNotice: vi.fn(),
  verifyPassword: vi.fn(),
  member: vi.fn(),
  account: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: m.getUser } }) }))
vi.mock('@/lib/portal/i18n', () => ({ getLocale: (u: { user_metadata?: { portal_language?: string } }) => u.user_metadata?.portal_language ?? 'en' }))
vi.mock('@/lib/portal/team/login-notice-accept', () => ({ acceptTeamLoginNotice: m.accept }))
vi.mock('@/lib/portal/team/login-notice-server', () => ({ acceptNoticeDeps: () => ({ deps: true }) }))
vi.mock('@/lib/portal/team/server', () => ({ assertAccountAdmin: m.assertAdmin }))
vi.mock('@/lib/portal/team/confirm-request', () => ({ ownerNoticeLang: () => 'en' }))
vi.mock('@/lib/portal/team/confirm', () => ({ checkNoticeAcceptance: m.checkNotice, verifyOwnerPassword: m.verifyPassword }))
vi.mock('@/lib/portal/team/personal-docs-notice', () => ({ buildPersonalDocsNotice: () => ({ version: 'v1-docs', text: 'the words' }) }))
vi.mock('@/lib/portal/team/personal-docs-share', () => ({ setPersonalDocShare: m.setShare }))
vi.mock('@/lib/portal/team/personal-docs-server', () => ({ shareDeps: () => ({ share: true }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'accounts' ? m.account() : m.member(), error: null }) }), maybeSingle: async () => ({ data: m.account(), error: null }) }) }) }),
  },
}))

import { POST as acceptRoute } from '@/app/api/portal/team/accept-notice/route'
import { POST as shareRoute } from '@/app/api/portal/team/[id]/personal-docs/route'

const req = (body: unknown, headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }) =>
  ({ json: async () => body, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as import('next/server').NextRequest
const teamUser = { id: 'tu1', app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1' }, user_metadata: {} }
const owner = { id: 'ou1', email: 'owner@example.com', user_metadata: {} }

beforeEach(() => {
  vi.clearAllMocks()
  m.getUser.mockResolvedValue({ data: { user: teamUser } })
  m.accept.mockResolvedValue({ ok: true, alreadyAccepted: false })
  m.assertAdmin.mockResolvedValue('c-owner')
  m.member.mockReturnValue({ display_name: 'Anna' })
  m.account.mockReturnValue({ company_name: 'Acme LLC' })
  m.checkNotice.mockReturnValue({ ok: true, confirmation: { version: 'v1-docs', text: 'the words', ip: '203.0.113.9' } })
  m.verifyPassword.mockResolvedValue({ ok: true })
  m.setShare.mockResolvedValue({ ok: true, changed: true })
})

describe('POST /api/portal/team/accept-notice (the login accepts its OWN notice)', () => {
  it('needs a sign-in', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await acceptRoute(req({ version: 'v1' }))).status).toBe(401)
    expect(m.accept).not.toHaveBeenCalled()
  })
  it('only a TEAM login may (an ordinary client, an owner or staff are refused)', async () => {
    m.getUser.mockResolvedValue({ data: { user: { id: 'c1', app_metadata: { role: 'client', contact_id: 'c1' } } } })
    expect((await acceptRoute(req({ version: 'v1' }))).status).toBe(403)
    expect(m.accept).not.toHaveBeenCalled()
  })
  it('a team login still on its temporary password must choose its own password first', async () => {
    m.getUser.mockResolvedValue({ data: { user: { ...teamUser, app_metadata: { ...teamUser.app_metadata, must_change_password: true } } } })
    const res = await acceptRoute(req({ version: 'v1' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Choose your own password first.')
    expect(m.accept).not.toHaveBeenCalled()
  })
  it('accepts for the SIGNED-IN login only (never an id from the request), in its language, with the address and the version it was shown', async () => {
    m.getUser.mockResolvedValue({ data: { user: { ...teamUser, user_metadata: { portal_language: 'it' } } } })
    const res = await acceptRoute(req({ version: 'v1-draft-login', user_id: 'someone-else' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, alreadyAccepted: false })
    expect(m.accept).toHaveBeenCalledWith({ authUserId: 'tu1', lang: 'it', shownVersion: 'v1-draft-login', ip: '203.0.113.9' }, { deps: true })
  })
  it('a refusal from the rule (e.g. the notice changed while it was read) keeps its own status and message', async () => {
    m.accept.mockResolvedValue({ ok: false, status: 409, error: 'The notice changed. Please read it again.' })
    const res = await acceptRoute(req({ version: 'old' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('The notice changed. Please read it again.')
  })
  it('accepting a second time says so (alreadyAccepted) without error', async () => {
    m.accept.mockResolvedValue({ ok: true, alreadyAccepted: true })
    expect(await (await acceptRoute(req({ version: 'v1' }))).json()).toEqual({ success: true, alreadyAccepted: true })
  })
})

describe('POST /api/portal/team/[id]/personal-docs (share or stop sharing MY OWN papers)', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ account_id: 'a1', enabled: true, notice_accepted: true, notice_version: 'v1-docs', notice_text: 'the words', owner_password: 'pw', ...extra })
  beforeEach(() => { m.getUser.mockResolvedValue({ data: { user: owner } }) })

  it('needs a sign-in and an owner or member of that company', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await shareRoute(req(body()), { params: { id: 't1' } })).status).toBe(401)
    m.getUser.mockResolvedValue({ data: { user: owner } })
    m.assertAdmin.mockResolvedValue(null)
    expect((await shareRoute(req(body()), { params: { id: 't1' } })).status).toBe(403)
    expect(m.setShare).not.toHaveBeenCalled()
  })
  it('"enabled" must be a yes or no', async () => {
    const res = await shareRoute(req(body({ enabled: 'yes' })), { params: { id: 't1' } })
    expect(res.status).toBe(400)
    expect(m.setShare).not.toHaveBeenCalled()
  })
  it('sharing needs the notice accepted word for word AND the owner\'s password, in the same request', async () => {
    m.checkNotice.mockReturnValue({ ok: false, status: 409, error: 'The notice changed while you were reading it.' })
    let res = await shareRoute(req(body()), { params: { id: 't1' } })
    expect(res.status).toBe(409)
    expect(m.setShare).not.toHaveBeenCalled()
    m.checkNotice.mockReturnValue({ ok: true, confirmation: { version: 'v1-docs', text: 'the words', ip: '203.0.113.9' } })
    m.verifyPassword.mockResolvedValue({ ok: false, status: 403, error: 'That password is not correct.' })
    res = await shareRoute(req(body()), { params: { id: 't1' } })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('That password is not correct.')
    expect(m.setShare).not.toHaveBeenCalled()
  })
  it('a login that is not in this company is "not found", never shared with', async () => {
    m.member.mockReturnValue(null)
    expect((await shareRoute(req(body()), { params: { id: 'other-company-login' } })).status).toBe(404)
    expect(m.setShare).not.toHaveBeenCalled()
  })
  it('the OWNER whose papers are shared is always the signed-in person (never anything in the request)', async () => {
    const res = await shareRoute(req(body({ owner_contact_id: 'a-co-owner' })), { params: { id: 't1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true })
    expect(m.setShare).toHaveBeenCalledWith(
      expect.objectContaining({ teamMemberId: 't1', accountId: 'a1', ownerContactId: 'c-owner', enabled: true, confirmation: { version: 'v1-docs', text: 'the words', ip: '203.0.113.9' } }),
      { share: true },
    )
  })
  it('sharing with no proof at all is passed down without a confirmation and comes back as "needs confirmation" (409)', async () => {
    m.setShare.mockResolvedValue({ ok: false, status: 409, error: 'Read the notice and confirm with your password to share your personal documents.', needsConfirmation: true })
    const res = await shareRoute(req({ account_id: 'a1', enabled: true }), { params: { id: 't1' } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ needs_confirmation: true })
    expect(m.setShare).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, confirmation: null }), { share: true })
    expect(m.verifyPassword).not.toHaveBeenCalled()
  })
  it('stopping needs nothing: no notice, no password', async () => {
    const res = await shareRoute(req({ account_id: 'a1', enabled: false }), { params: { id: 't1' } })
    expect(res.status).toBe(200)
    expect(m.verifyPassword).not.toHaveBeenCalled()
    expect(m.checkNotice).not.toHaveBeenCalled()
    expect(m.setShare).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, confirmation: null, ownerContactId: 'c-owner' }), { share: true })
  })
})
