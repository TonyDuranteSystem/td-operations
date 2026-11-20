import { describe, it, expect } from 'vitest'
import {
  buildTeamLoginNotice,
  TEAM_LOGIN_NOTICE_VERSION,
  teamLoginNoticeAcceptLabel,
  teamLoginNoticeBannerTitle,
  teamLoginNoticeLimitLine,
} from '@/lib/portal/team/login-notice'
import { acceptTeamLoginNotice, isNoticeWaiting, type AcceptDeps, type AcceptRow } from '@/lib/portal/team/login-notice-accept'
import { resolvePortalIdentity, type ResolveDeps } from '@/lib/portal/resolve-portal-identity'
import type { TeamEventInput } from '@/lib/portal/team/events'
import type { User } from '@supabase/supabase-js'

// ── the words ────────────────────────────────────────────────────────────────
describe('buildTeamLoginNotice', () => {
  const caps = { documents: true, chat: true }

  it('is written to the team login ("you"), names the company, lists the real powers and carries the version', () => {
    const n = buildTeamLoginNotice({ lang: 'en', memberName: 'Sam', companyName: '  Acme   LLC ', caps })
    expect(n.version).toBe(TEAM_LOGIN_NOTICE_VERSION)
    expect(n.title).toBe('You have access to Acme LLC through a team login.')
    expect(n.powers.length).toBeGreaterThan(0)
    expect(n.text).toContain(n.title)
    for (const p of n.powers) expect(n.text).toContain(`- ${p}`)
    expect(n.text).toContain('they are responsible for what you do')
    expect(n.text.endsWith(`[${TEAM_LOGIN_NOTICE_VERSION}]`)).toBe(true)
  })

  it('says what the login can never do', () => {
    const n = buildTeamLoginNotice({ lang: 'en', memberName: 'Sam', companyName: 'Acme LLC', caps })
    expect(n.never).toMatch(/never sign anything/)
    expect(n.never).toMatch(/generate documents/)
    expect(n.never).toMatch(/switch your access off/)
  })

  it('exists in Italian too, with the same shape', () => {
    const n = buildTeamLoginNotice({ lang: 'it', memberName: 'Sam', companyName: 'Acme LLC', caps })
    expect(n.title).toBe('Hai accesso a Acme LLC con un login del team.')
    expect(n.responsibility).toMatch(/titolari/)
    expect(n.never).toMatch(/non puoi mai firmare/)
    expect(n.text).toContain(`[${TEAM_LOGIN_NOTICE_VERSION}]`)
  })

  it('shows a clear line when no power is ticked', () => {
    expect(buildTeamLoginNotice({ lang: 'en', memberName: 'Sam', companyName: 'X', caps: {} }).text).toContain('(no powers ticked)')
    expect(buildTeamLoginNotice({ lang: 'it', memberName: 'Sam', companyName: 'X', caps: {} }).text).toContain('(nessun potere selezionato)')
  })

  it('never guesses a pronoun: no he/she/his/her/lui/lei in either language', () => {
    for (const lang of ['en', 'it'] as const) {
      const n = buildTeamLoginNotice({ lang, memberName: 'Alex', companyName: 'Acme LLC', caps })
      expect(n.text).not.toMatch(/\b(he|she|his|hers?|lui|lei)\b/i)
    }
  })

  it('has banner words in both languages', () => {
    expect(teamLoginNoticeAcceptLabel('en')).toMatch(/accept/i)
    expect(teamLoginNoticeAcceptLabel('it')).toMatch(/accetto/i)
    expect(teamLoginNoticeBannerTitle('en').length).toBeGreaterThan(10)
    expect(teamLoginNoticeBannerTitle('it').length).toBeGreaterThan(10)
    expect(teamLoginNoticeLimitLine('en')).toMatch(/home page/)
    expect(teamLoginNoticeLimitLine('it')).toMatch(/pagina iniziale/)
  })
})

// ── who is waiting ───────────────────────────────────────────────────────────
describe('isNoticeWaiting', () => {
  it('is true only for an ACTIVE login with no notice version (strictly null)', () => {
    expect(isNoticeWaiting({ status: 'active', notice_version: null })).toBe(true)
    expect(isNoticeWaiting({ status: 'active', notice_version: 'v1-draft' })).toBe(false)
    expect(isNoticeWaiting({ status: 'revoked', notice_version: null })).toBe(false)
    expect(isNoticeWaiting({ status: 'active' })).toBe(false) // not selected = not waiting
    expect(isNoticeWaiting(null)).toBe(false)
  })
})

// ── accepting ────────────────────────────────────────────────────────────────
function fakeDeps(row: AcceptRow | null, over: Partial<AcceptDeps> = {}) {
  const events: TeamEventInput[] = []
  const calls = { marked: [] as unknown[], unmarked: [] as string[] }
  const deps: AcceptDeps = {
    fetchRow: async () => row,
    companyName: async () => 'Acme LLC',
    markAccepted: async (id, patch) => {
      calls.marked.push({ id, ...patch })
      return true
    },
    unmark: async (id) => {
      calls.unmarked.push(id)
    },
    recordEvent: async (e) => {
      events.push(e)
    },
    recordEventBestEffort: async (e) => {
      events.push(e)
      return true
    },
    now: () => new Date('2026-11-20T12:00:00.000Z'),
    ...over,
  }
  return { deps, events, calls }
}

const waitingRow: AcceptRow = {
  id: 'tm-1',
  account_id: 'acc-1',
  display_name: 'Sam',
  status: 'active',
  notice_version: null,
  capabilities: { documents: true, chat: true },
  created_at: '2026-10-01T00:00:00.000Z',
}

const input = { authUserId: 'auth-1', lang: 'en' as const, shownVersion: TEAM_LOGIN_NOTICE_VERSION, ip: '203.0.113.9' }

describe('acceptTeamLoginNotice', () => {
  it('saves the version, the time and the address, then records the exact words', async () => {
    const { deps, events, calls } = fakeDeps(waitingRow)
    const r = await acceptTeamLoginNotice(input, deps)
    expect(r).toEqual({ ok: true, alreadyAccepted: false })
    expect(calls.marked).toEqual([
      { id: 'tm-1', notice_version: TEAM_LOGIN_NOTICE_VERSION, notice_accepted_at: '2026-11-20T12:00:00.000Z', notice_accepted_ip: '203.0.113.9' },
    ])
    const accepted = events.find((e) => e.event === 'notice_accepted')!
    expect(accepted.actor).toEqual({ kind: 'system', ip: '203.0.113.9' })
    expect(accepted.detail?.accepted_by).toBe('team_login')
    expect(accepted.detail?.notice_version).toBe(TEAM_LOGIN_NOTICE_VERSION)
    expect(String(accepted.detail?.notice_text)).toContain('You have access to Acme LLC through a team login.')
    expect(String(accepted.detail?.notice_text)).toMatch(/- /) // the real powers are in the saved words
    const migrated = events.find((e) => e.event === 'migrated')!
    expect(migrated.detail?.created_at).toBe('2026-10-01T00:00:00.000Z')
  })

  it('builds the words on the server in the login\'s language (Italian)', async () => {
    const { deps, events } = fakeDeps(waitingRow)
    await acceptTeamLoginNotice({ ...input, lang: 'it' }, deps)
    expect(String(events.find((e) => e.event === 'notice_accepted')!.detail?.notice_text)).toContain('Hai accesso a Acme LLC con un login del team.')
  })

  it('refuses a login with no row, or one that is not active (a switched-off login cannot accept)', async () => {
    for (const row of [null, { ...waitingRow, status: 'revoked' }]) {
      const { deps, calls } = fakeDeps(row)
      const r = await acceptTeamLoginNotice(input, deps)
      expect(r).toMatchObject({ ok: false, status: 403 })
      expect(calls.marked).toEqual([])
    }
  })

  it('accepting twice changes nothing the second time', async () => {
    const { deps, events, calls } = fakeDeps({ ...waitingRow, notice_version: 'v1-draft-login' })
    const r = await acceptTeamLoginNotice(input, deps)
    expect(r).toEqual({ ok: true, alreadyAccepted: true })
    expect(calls.marked).toEqual([])
    expect(events).toEqual([])
  })

  it('two windows at once: the second write finds the version already set and changes nothing', async () => {
    const { deps, events } = fakeDeps(waitingRow, { markAccepted: async () => false })
    const r = await acceptTeamLoginNotice(input, deps)
    expect(r).toEqual({ ok: true, alreadyAccepted: true })
    expect(events).toEqual([])
  })

  it('refuses a version the person was not shown (so nobody accepts words they did not read)', async () => {
    const { deps, calls } = fakeDeps(waitingRow)
    for (const shown of ['v0', undefined, null, 5, '']) {
      const r = await acceptTeamLoginNotice({ ...input, shownVersion: shown }, deps)
      expect(r).toMatchObject({ ok: false, status: 409 })
    }
    expect(calls.marked).toEqual([])
  })

  it('no record, no grant: if the record line cannot be saved the acceptance is undone', async () => {
    const { deps, calls } = fakeDeps(waitingRow, {
      recordEvent: async () => {
        throw new Error('db down')
      },
    })
    const r = await acceptTeamLoginNotice(input, deps)
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect(calls.unmarked).toEqual(['tm-1'])
  })

  it('a failing informational line never blocks the acceptance', async () => {
    const { deps } = fakeDeps(waitingRow, { recordEventBestEffort: async () => false })
    expect(await acceptTeamLoginNotice(input, deps)).toEqual({ ok: true, alreadyAccepted: false })
  })
})

// ── holding the powers back ──────────────────────────────────────────────────
function user(app_metadata: Record<string, unknown>): User {
  return { id: 'auth-1', app_metadata } as unknown as User
}
function resolveDeps(row: Awaited<ReturnType<ResolveDeps['fetchTeamMemberByAuthId']>>): ResolveDeps {
  return { fetchTeamMemberByAuthId: async () => row, getContactId: () => null, getAccountIds: async () => [] }
}
const baseRow = { id: 'tm-1', account_id: 'acc-1', display_name: 'Sam', email: null, capabilities: { documents: true, chat: true }, status: 'active' }

describe('resolvePortalIdentity — a login waiting for its notice', () => {
  it('holds EVERY power back (empty capabilities) and says the notice is pending', async () => {
    const id = await resolvePortalIdentity(user({ kind: 'team_member' }), resolveDeps({ ...baseRow, notice_version: null }))
    expect(id).toMatchObject({ kind: 'teammate', noticePending: true, capabilities: {} })
  })

  it('gives the real powers once a notice is on file', async () => {
    const id = await resolvePortalIdentity(user({ kind: 'team_member' }), resolveDeps({ ...baseRow, notice_version: 'v1-draft' }))
    expect(id).toMatchObject({ kind: 'teammate', capabilities: { documents: true, chat: true } })
    expect((id as { noticePending?: boolean }).noticePending).toBeUndefined()
  })

  it('a row that did not report the notice at all is NOT treated as waiting (never locks anyone out by accident)', async () => {
    const id = await resolvePortalIdentity(user({ kind: 'team_member' }), resolveDeps({ ...baseRow }))
    expect(id).toMatchObject({ kind: 'teammate', capabilities: { documents: true, chat: true } })
    expect((id as { noticePending?: boolean }).noticePending).toBeUndefined()
  })

  it('a switched-off login still has no access at all', async () => {
    const id = await resolvePortalIdentity(user({ kind: 'team_member' }), resolveDeps({ ...baseRow, status: 'revoked', notice_version: null }))
    expect(id).toEqual({ kind: 'none' })
  })
})
