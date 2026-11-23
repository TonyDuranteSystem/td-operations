/**
 * The Team screens must SAY when they cannot load, never show a failure as an answer (dev job e59dd470, bug hunt):
 *   - owner's Team page: an unreadable list of logins is not "no team"; an unreadable list of shares is not "nothing shared";
 *   - staff Team card: an unreadable list is not "no team logins" (the card used to vanish).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Result = { data: unknown; error: { message: string } | null }

const h = vi.hoisted(() => ({
  queue: {} as Record<string, Array<{ data: unknown; error: { message: string } | null }>>,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const next = () => (h.queue[table] ?? []).shift() ?? { data: [], error: null }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej),
      }
      return chain
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { last_sign_in_at: null } } }) } },
  },
}))

import { teamCardMode } from '@/lib/portal/team/crm-view'
import { loadTeamPageData } from '@/lib/portal/team/team-page-data'
import { getMySharedMemberIds } from '@/lib/portal/team/personal-docs-server'
import { listTeammates } from '@/lib/portal/team/server'
import { loadTeamCard } from '@/lib/portal/team/crm-server'

const ok = (data: unknown): Result => ({ data, error: null })
const bad = (message = 'db down'): Result => ({ data: null, error: { message } })

beforeEach(() => {
  h.queue = {}
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('teamCardMode (staff card, pure)', () => {
  it('draws nothing for a company with no team logins', () => {
    expect(teamCardMode({ hasData: true, memberCount: 0, failed: false })).toBe('hidden')
    expect(teamCardMode({ hasData: false, memberCount: 0, failed: false })).toBe('hidden') // still loading
  })
  it('a FAILED load is a notice, never the same as "no team logins"', () => {
    expect(teamCardMode({ hasData: false, memberCount: 0, failed: true })).toBe('failed')
  })
  it('a list already on screen stays (out of date) when a refresh fails', () => {
    expect(teamCardMode({ hasData: true, memberCount: 2, failed: true })).toBe('list')
    expect(teamCardMode({ hasData: true, memberCount: 2, failed: false })).toBe('list')
  })
})

describe('loadTeamPageData (owner Team page, pure)', () => {
  const people = [{ id: 'm1' }, { id: 'm2' }]

  it('marks who the owner shared with', async () => {
    const r = await loadTeamPageData('a1', 'c1', { listTeammates: async () => people, getMySharedMemberIds: async () => new Set(['m2']) })
    expect(r).toEqual({ kind: 'ok', sharesUnavailable: false, teammates: [{ id: 'm1', sharesMyDocs: false }, { id: 'm2', sharesMyDocs: true }] })
  })

  it('an unreadable list of logins is a FAILURE, never "no team"', async () => {
    const r = await loadTeamPageData('a1', 'c1', { listTeammates: async () => { throw new Error('down') }, getMySharedMemberIds: async () => new Set() })
    expect(r).toEqual({ kind: 'failed' })
  })

  it('an unreadable list of shares keeps the logins but says sharing cannot be checked (never "nothing shared")', async () => {
    const r = await loadTeamPageData('a1', 'c1', { listTeammates: async () => people, getMySharedMemberIds: async () => { throw new Error('down') } })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sharesUnavailable).toBe(true)
      expect(r.teammates.map((t) => t.id)).toEqual(['m1', 'm2'])
    }
  })

  it('a company with no logins is a normal empty answer, not a failure', async () => {
    const r = await loadTeamPageData('a1', 'c1', { listTeammates: async () => [], getMySharedMemberIds: async () => new Set() })
    expect(r).toEqual({ kind: 'ok', teammates: [], sharesUnavailable: false })
  })
})

describe('getMySharedMemberIds', () => {
  it('returns the logins the owner shared with', async () => {
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1' }, { team_member_id: 'm3' }])]
    expect([...(await getMySharedMemberIds('a1', 'c1'))].sort()).toEqual(['m1', 'm3'])
  })
  it('an empty answer is "nothing shared"', async () => {
    h.queue.portal_team_document_shares = [ok([])]
    expect((await getMySharedMemberIds('a1', 'c1')).size).toBe(0)
  })
  it('THROWS when the list cannot be read (it used to answer "nothing shared")', async () => {
    h.queue.portal_team_document_shares = [bad('read failed')]
    await expect(getMySharedMemberIds('a1', 'c1')).rejects.toThrow('read failed')
  })
})

describe('listTeammates', () => {
  const row = { id: 'm1', username: 'luca', display_name: 'Luca', email: null, capabilities: {}, status: 'active', created_at: '2026-01-01' }

  it('lists the logins', async () => {
    h.queue.portal_team_members = [ok([row])]
    expect((await listTeammates('a1')).map((r) => r.id)).toEqual(['m1'])
  })
  it('an empty company is a normal empty list', async () => {
    h.queue.portal_team_members = [ok([])]
    expect(await listTeammates('a1')).toEqual([])
  })
  it('falls back to the old columns when only the first read fails', async () => {
    h.queue.portal_team_members = [bad('no such column'), ok([row])]
    expect((await listTeammates('a1')).map((r) => r.id)).toEqual(['m1'])
  })
  it('THROWS when both reads fail (it used to answer "no team")', async () => {
    h.queue.portal_team_members = [bad('down'), bad('down')]
    await expect(listTeammates('a1')).rejects.toThrow('Could not read the team logins')
  })
})

describe('loadTeamCard (staff)', () => {
  const row = { id: 'm1', auth_user_id: 'u1', username: 'luca', display_name: 'Luca', capabilities: {}, status: 'active', created_at: '2026-01-01' }

  it('THROWS when both reads of the logins fail (the card used to vanish as "no team logins")', async () => {
    h.queue.portal_team_members = [bad('down'), bad('down')]
    await expect(loadTeamCard('a1')).rejects.toThrow('Could not read the team logins')
  })
  it('an old database (first read fails, old columns work) still lists the people read-only', async () => {
    h.queue.portal_team_members = [bad('no such column'), ok([row])]
    const card = await loadTeamCard('a1')
    expect(card.ready).toBe(false)
    expect(card.members).toHaveLength(1)
  })
  it('a company with no logins is a normal empty card', async () => {
    h.queue.portal_team_members = [ok([])]
    expect(await loadTeamCard('a1')).toEqual({ ready: true, members: [], sharing: { available: true, lines: [] } })
  })
})
