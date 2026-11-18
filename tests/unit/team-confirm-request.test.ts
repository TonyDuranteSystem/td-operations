import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ account: vi.fn(), locale: vi.fn(), verify: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => h.account() }) }) }) },
}))
vi.mock('@/lib/portal/i18n', () => ({ getLocale: h.locale }))
vi.mock('@/lib/portal/team/confirm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/portal/team/confirm')>('@/lib/portal/team/confirm')
  return { ...actual, verifyOwnerPassword: h.verify }
})

import { confirmGrant, ownerNoticeLang } from '@/lib/portal/team/confirm-request'
import { buildNotice } from '@/lib/portal/team/notice'
import type { User } from '@supabase/supabase-js'

const user = { id: 'u1', email: 'owner@example.com' } as User
const base = { user, accountId: 'a1', memberName: 'Anna Rossi', caps: { chat: true, bogus: true }, mode: 'add' as const, ip: '1.2.3.4' }
const expectedText = (lang: 'en' | 'it' = 'en') => buildNotice({ lang, mode: 'add', memberName: 'Anna Rossi', companyName: 'Acme LLC', caps: { chat: true } }).text

beforeEach(() => {
  vi.clearAllMocks()
  h.account.mockResolvedValue({ data: { company_name: 'Acme LLC' }, error: null })
  h.locale.mockReturnValue('en')
  h.verify.mockResolvedValue({ ok: true })
})

describe('confirmGrant', () => {
  const body = (over: Record<string, unknown> = {}) => ({ notice_accepted: true, notice_version: 'v1-draft', notice_text: expectedText(), owner_password: 'pw', ...over })

  it('accepts when the owner read the SAME words the server builds, and the password is right', async () => {
    const r = await confirmGrant({ ...base, body: body() })
    expect(r).toEqual({ ok: true, confirmation: { version: 'v1-draft', text: expectedText(), ip: '1.2.3.4' } })
    expect(h.verify).toHaveBeenCalledWith({ userId: 'u1', email: 'owner@example.com', password: 'pw' })
  })
  it('builds the words from the powers the server knows (an unknown tick sent by the browser is ignored)', async () => {
    expect((await confirmGrant({ ...base, caps: { chat: true, bogus: true, documents: true }, body: body() })).ok).toBe(false)
  })
  it('refuses different words than the server builds (409) and never asks for the password then', async () => {
    const r = await confirmGrant({ ...base, body: body({ notice_text: 'something else' }) })
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(h.verify).not.toHaveBeenCalled()
  })
  it('refuses when the box was not ticked, before checking the password', async () => {
    expect(await confirmGrant({ ...base, body: body({ notice_accepted: false }) })).toMatchObject({ ok: false, status: 400 })
    expect(h.verify).not.toHaveBeenCalled()
  })
  it('passes on a wrong or locked password with its own status', async () => {
    h.verify.mockResolvedValue({ ok: false, status: 429, error: 'Too many wrong passwords.' })
    expect(await confirmGrant({ ...base, body: body() })).toEqual({ ok: false, status: 429, error: 'Too many wrong passwords.' })
  })
  it('an unknown company is 404', async () => {
    h.account.mockResolvedValue({ data: null, error: null })
    expect(await confirmGrant({ ...base, body: body() })).toMatchObject({ ok: false, status: 404 })
  })
  it('follows the owner\'s language: an Italian owner is shown, and must accept, the Italian words', async () => {
    h.locale.mockReturnValue('it')
    expect(ownerNoticeLang(user)).toBe('it')
    expect((await confirmGrant({ ...base, body: body() })).ok).toBe(false) // the English words no longer match
    expect((await confirmGrant({ ...base, body: body({ notice_text: expectedText('it') }) })).ok).toBe(true)
  })
})
