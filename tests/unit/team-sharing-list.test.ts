/**
 * The STAFF "who shares their personal documents with whom" list on the CRM Team card (dev job e59dd470, bug hunt):
 *   - each share is a line that says whether the login can REALLY see the papers now (same conditions as the viewing rule);
 *   - a list that cannot be read is a notice, never "nobody shares";
 *   - the staff card data carries it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Result = { data: unknown; error: { message: string } | null }

const h = vi.hoisted(() => ({
  queue: {} as Record<string, Array<{ data: unknown; error: { message: string } | null }>>,
  current: new Set<string>(),
  managersFail: false,
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

vi.mock('@/lib/portal/team/may-manage', () => ({
  listTeamManagers: async () => {
    if (h.managersFail) throw new Error('could not read the owners and members')
    return Array.from(h.current).map((contactId) => ({ contactId, fullName: null, email: null, language: null }))
  },
}))

import { buildSharingList, sharingBlockMode, sharingStatus, SHARING_STATUS_TEXT } from '@/lib/portal/team/sharing-list'
import { loadSharing, loadTeamCard } from '@/lib/portal/team/crm-server'

const ok = (data: unknown): Result => ({ data, error: null })
const bad = (message = 'db down'): Result => ({ data: null, error: { message } })

const active = { status: 'active', switched_off_at: null, switched_off_by: null, notice_version: 'v1', capabilities: { documents: true } }

beforeEach(() => {
  h.queue = {}
  h.current = new Set()
  h.managersFail = false
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('sharingStatus (pure) — same conditions as the viewing rule', () => {
  it('an active login with the Documents power and a current owner CAN see them', () => {
    expect(sharingStatus(active, true)).toBe('can_see')
  })
  it('a login that no longer exists, or is switched off or removed, cannot', () => {
    expect(sharingStatus(null, true)).toBe('login_off')
    expect(sharingStatus({ ...active, status: 'removed' }, true)).toBe('login_off')
    expect(sharingStatus({ ...active, status: 'inactive', switched_off_at: '2026-11-01T00:00:00Z', switched_off_by: 'td' }, true)).toBe('login_off')
  })
  it('a login still waiting for its own notice cannot see them yet (its powers are held back)', () => {
    expect(sharingStatus({ ...active, notice_version: null }, true)).toBe('waiting_notice')
  })
  it('a login without the Documents power cannot', () => {
    expect(sharingStatus({ ...active, capabilities: { chat: true } }, true)).toBe('no_documents_power')
  })
  it('an owner who is no longer an owner or member of the company: the share is ignored', () => {
    expect(sharingStatus(active, false)).toBe('owner_not_current')
  })
  it('a missing notice column (older database) is not "waiting"', () => {
    const { notice_version: _omit, ...noColumn } = active
    expect(sharingStatus(noColumn, true)).toBe('can_see')
  })
  it('every status has a plain-English sentence', () => {
    for (const s of ['can_see', 'login_off', 'waiting_notice', 'no_documents_power', 'owner_not_current'] as const) expect(SHARING_STATUS_TEXT[s].length).toBeGreaterThan(5)
  })
})

describe('buildSharingList (pure)', () => {
  const members = [
    { id: 'm1', username: 'anna', display_name: 'Anna', capabilities: { documents: true }, status: 'active', created_at: '2026-01-01', notice_version: 'v1' },
    { id: 'm2', username: 'bob', display_name: 'Bob', capabilities: { documents: true }, status: 'active', created_at: '2026-01-02', notice_version: null },
  ]
  const shares = [
    { team_member_id: 'm2', owner_contact_id: 'o1', created_at: '2026-11-05T10:00:00Z' },
    { team_member_id: 'm1', owner_contact_id: 'o1', created_at: '2026-11-01T10:00:00Z' },
    { team_member_id: 'gone', owner_contact_id: 'o2', created_at: '2026-11-09T10:00:00Z' },
  ]

  it('names the owner and the login, and puts "can see now" first', () => {
    const lines = buildSharingList({ shares, members, ownerNames: { o1: 'Peter Papik' }, currentOwners: new Set(['o1']) })
    expect(lines.map((l) => [l.ownerName, l.loginName, l.status])).toEqual([
      ['Peter Papik', 'Anna', 'can_see'],
      ['Peter Papik', 'Bob', 'waiting_notice'],
      ['An owner', 'A login that no longer exists', 'login_off'],
    ])
  })
  it('carries the date it was shared and the login username', () => {
    const lines = buildSharingList({ shares, members, ownerNames: {}, currentOwners: new Set(['o1']) })
    expect(lines[0]).toMatchObject({ loginUsername: 'anna', since: '2026-11-01T10:00:00Z' })
  })
  it('no shares is an empty list', () => {
    expect(buildSharingList({ shares: [], members, ownerNames: {}, currentOwners: new Set() })).toEqual([])
  })
})

describe('sharingBlockMode (pure)', () => {
  it('an unreadable list is "unavailable", never "empty"', () => {
    expect(sharingBlockMode({ available: false, lineCount: 0 })).toBe('unavailable')
  })
  it('a readable empty list is "empty"; otherwise "list"', () => {
    expect(sharingBlockMode({ available: true, lineCount: 0 })).toBe('empty')
    expect(sharingBlockMode({ available: true, lineCount: 2 })).toBe('list')
  })
})

describe('loadSharing (database read)', () => {
  const member = { id: 'm1', username: 'anna', display_name: 'Anna', capabilities: { documents: true }, status: 'active', created_at: '2026-01-01', notice_version: 'v1' }

  it('lists a share with the owner name and whether the login can see it', async () => {
    h.current = new Set(['o1'])
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1', owner_contact_id: 'o1', created_at: '2026-11-01T10:00:00Z' }])]
    h.queue.contacts = [ok([{ id: 'o1', full_name: 'Peter Papik' }])]
    const r = await loadSharing('a1', [member])
    expect(r.available).toBe(true)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toMatchObject({ ownerName: 'Peter Papik', loginName: 'Anna', status: 'can_see' })
  })
  it('an owner who left the company: listed, but "cannot see"', async () => {
    h.current = new Set()
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1', owner_contact_id: 'o1', created_at: '2026-11-01T10:00:00Z' }])]
    h.queue.contacts = [ok([{ id: 'o1', full_name: 'Peter Papik' }])]
    expect((await loadSharing('a1', [member])).lines[0].status).toBe('owner_not_current')
  })
  it('no shares is a normal empty list', async () => {
    h.queue.portal_team_document_shares = [ok([])]
    expect(await loadSharing('a1', [member])).toEqual({ available: true, lines: [] })
  })
  it('an unreadable shares list is NOT "nobody shares"', async () => {
    h.queue.portal_team_document_shares = [bad('read failed')]
    expect(await loadSharing('a1', [member])).toEqual({ available: false, lines: [] })
  })
  it('an unreadable list of the current owners is NOT drawn as "cannot see" for every owner', async () => {
    h.managersFail = true
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1', owner_contact_id: 'o1', created_at: '2026-11-01T10:00:00Z' }])]
    h.queue.contacts = [ok([{ id: 'o1', full_name: 'Peter Papik' }])]
    expect(await loadSharing('a1', [member])).toEqual({ available: false, lines: [] })
  })
  it('an unreadable owner-name lookup is NOT drawn as a list with blank names', async () => {
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1', owner_contact_id: 'o1', created_at: null }])]
    h.queue.contacts = [bad('names failed')]
    expect(await loadSharing('a1', [member])).toEqual({ available: false, lines: [] })
  })
})

describe('loadTeamCard carries the sharing list', () => {
  const row = { id: 'm1', auth_user_id: 'u1', username: 'anna', display_name: 'Anna', capabilities: { documents: true }, status: 'active', created_at: '2026-01-01', notice_version: 'v1' }

  it('returns the people and the sharing list together', async () => {
    h.current = new Set(['o1'])
    h.queue.portal_team_members = [ok([row])]
    h.queue.portal_team_events = [ok([])]
    h.queue.portal_team_document_shares = [ok([{ team_member_id: 'm1', owner_contact_id: 'o1', created_at: '2026-11-01T10:00:00Z' }])]
    h.queue.contacts = [ok([{ id: 'o1', full_name: 'Peter Papik' }])]
    const card = await loadTeamCard('a1')
    expect(card.members).toHaveLength(1)
    expect(card.sharing.available).toBe(true)
    expect(card.sharing.lines[0]).toMatchObject({ ownerName: 'Peter Papik', loginName: 'Anna', status: 'can_see' })
  })
  it('a failed sharing read does not hide the people', async () => {
    h.queue.portal_team_members = [ok([row])]
    h.queue.portal_team_events = [ok([])]
    h.queue.portal_team_document_shares = [bad('down')]
    const card = await loadTeamCard('a1')
    expect(card.members).toHaveLength(1)
    expect(card.sharing).toEqual({ available: false, lines: [] })
  })
})
