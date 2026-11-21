import { describe, it, expect } from 'vitest'
import { buildTeamCard, cardState, HISTORY_LIMIT, type CardEventRow, type CardMemberRow } from '@/lib/portal/team/crm-view'
import { tdActorFromRequest, buildTeamEventRow } from '@/lib/portal/team/events'

const base: CardMemberRow = {
  id: 'm1', auth_user_id: 'u1', username: 'anna.rossi', display_name: 'Anna Rossi',
  capabilities: { documents: true, chat: true }, status: 'active', created_at: '2026-11-01T10:00:00Z',
}
const ev = (over: Partial<CardEventRow>): CardEventRow => ({
  team_member_id: 'm1', event: 'added', actor_kind: 'owner', actor_contact_id: 'c1', actor_staff_email: null,
  detail: {}, created_at: '2026-11-01T10:00:00Z', ...over,
})

describe('cardState', () => {
  it('active, switched off by owner / TD, removed', () => {
    expect(cardState({ status: 'active' })).toBe('active')
    expect(cardState({ status: 'revoked', switched_off_at: '2026-11-02T00:00:00Z', switched_off_by: 'owner' })).toBe('off_owner')
    expect(cardState({ status: 'revoked', switched_off_at: '2026-11-02T00:00:00Z', switched_off_by: 'td' })).toBe('off_td')
    expect(cardState({ status: 'revoked', switched_off_at: null, switched_off_by: null })).toBe('removed')
  })
})

describe('buildTeamCard', () => {
  it('lists the ticked powers in plain words and who added the person', () => {
    const [m] = buildTeamCard({ members: [base], events: [ev({})], names: { c1: 'Marco Verdi' }, signIns: { u1: '2026-11-10T12:00:00Z' } })
    expect(m.powers).toEqual(['Documents', 'Chat'])
    expect(m.addedBy).toBe('Marco Verdi')
    expect(m.addedAt).toBe('2026-11-01T10:00:00Z')
    expect(m.lastSignIn).toBe('2026-11-10T12:00:00Z')
    expect(m.state).toBe('active')
    expect(m.switchedOff).toBeNull()
  })

  it('has no sign-in when the person never signed in, and never invents one', () => {
    const [m] = buildTeamCard({ members: [base], events: [], names: {}, signIns: { u1: null } })
    expect(m.lastSignIn).toBeNull()
    expect(m.addedBy).toBeNull()
    expect(m.addedAt).toBe(base.created_at)
  })

  it('names a TD staff login and the system as the actor', () => {
    const [m] = buildTeamCard({
      members: [base],
      events: [ev({ event: 'added', actor_kind: 'td', actor_contact_id: null, actor_staff_email: 'luca@tonydurante.us' }), ev({ event: 'password_reset', actor_kind: 'system', actor_contact_id: null, created_at: '2026-11-03T00:00:00Z' })],
      names: {}, signIns: {},
    })
    expect(m.addedBy).toBe('TD (luca@tonydurante.us)')
    expect(m.history[0].by).toBe('The system')
  })

  it('shows the saved words of the LATEST notice, with its version', () => {
    const [m] = buildTeamCard({
      members: [{ ...base, notice_version: 'v1-draft', notice_accepted_at: '2026-11-05T09:00:00Z', notice_accepted_ip: '1.2.3.4' }],
      events: [
        ev({ detail: { notice_version: 'v1-draft', notice_text: 'FIRST WORDS' } }),
        ev({ event: 'powers_changed', created_at: '2026-11-05T09:00:00Z', detail: { notice_version: 'v1-draft', notice_text: 'LATEST WORDS' } }),
        ev({ event: 'powers_changed', created_at: '2026-11-06T09:00:00Z', detail: { before: {}, after: {} } }),
      ],
      names: {}, signIns: {},
    })
    expect(m.notice).toEqual({ version: 'v1-draft', acceptedAt: '2026-11-05T09:00:00Z', ip: '1.2.3.4', text: 'LATEST WORDS' })
  })

  it('has no notice for a person who never accepted one', () => {
    const [m] = buildTeamCard({ members: [base], events: [ev({ detail: {} })], names: {}, signIns: {} })
    expect(m.notice).toBeNull()
  })

  it('shows who switched off, when and why', () => {
    const [m] = buildTeamCard({
      members: [{ ...base, status: 'revoked', switched_off_by: 'td', switched_off_at: '2026-11-07T00:00:00Z', switched_off_reason: '  left the company ' }],
      events: [ev({ event: 'switched_off', actor_kind: 'td', actor_contact_id: null, actor_staff_email: 'a@b.us', created_at: '2026-11-07T00:00:00Z', detail: { reason: 'left the company' } })],
      names: {}, signIns: {},
    })
    expect(m.state).toBe('off_td')
    expect(m.switchedOff).toEqual({ by: 'td', at: '2026-11-07T00:00:00Z', reason: 'left the company' })
    expect(m.history[0]).toMatchObject({ label: 'Switched off', reason: 'left the company' })
  })

  it('keeps only the newest history lines, newest first', () => {
    const events = Array.from({ length: HISTORY_LIMIT + 4 }, (_, i) => ev({ event: 'powers_changed', created_at: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:00Z` }))
    const [m] = buildTeamCard({ members: [base], events, names: {}, signIns: {} })
    expect(m.history).toHaveLength(HISTORY_LIMIT)
    expect(m.history[0].when > m.history[1].when).toBe(true)
  })

  it('sorts active people first and removed last, and never mixes up two people', () => {
    const removed: CardMemberRow = { ...base, id: 'm2', auth_user_id: 'u2', username: 'old', status: 'revoked', created_at: '2026-10-01T00:00:00Z' }
    const off: CardMemberRow = { ...base, id: 'm3', auth_user_id: 'u3', username: 'off', status: 'revoked', switched_off_at: '2026-11-02T00:00:00Z', switched_off_by: 'owner' }
    const out = buildTeamCard({
      members: [removed, off, base],
      events: [ev({ team_member_id: 'm2', event: 'removed' })],
      names: {}, signIns: { u1: 'A', u2: 'B', u3: 'C' },
    })
    expect(out.map((x) => x.id)).toEqual(['m1', 'm3', 'm2'])
    expect(out.find((x) => x.id === 'm1')?.history).toHaveLength(0)
    expect(out.find((x) => x.id === 'm2')?.history).toHaveLength(1)
    expect(out.find((x) => x.id === 'm3')?.lastSignIn).toBe('C')
  })

  it('a person with no powers ticked shows an empty list, not a crash', () => {
    const [m] = buildTeamCard({ members: [{ ...base, capabilities: null }], events: [], names: {}, signIns: {} })
    expect(m.powers).toEqual([])
  })
})

describe('tdActorFromRequest', () => {
  const headers = (v: string | null) => ({ get: (n: string) => (n === 'x-forwarded-for' ? v : null) })
  it('records the staff login and the first address', () => {
    expect(tdActorFromRequest('luca@tonydurante.us', headers('9.9.9.9, 10.0.0.1'))).toEqual({ kind: 'td', staffEmail: 'luca@tonydurante.us', ip: '9.9.9.9' })
    expect(tdActorFromRequest('luca@tonydurante.us', headers(null)).ip).toBeNull()
  })
  it('makes a valid record row, and a TD record without a staff login is refused', () => {
    const row = buildTeamEventRow({ teamMemberId: 'm1', accountId: 'a1', event: 'switched_off', actor: tdActorFromRequest('luca@tonydurante.us', headers(null)), detail: { reason: 'x' } })
    expect(row).toMatchObject({ actor_kind: 'td', actor_staff_email: 'luca@tonydurante.us', actor_contact_id: null })
    expect(() => buildTeamEventRow({ teamMemberId: 'm1', accountId: 'a1', event: 'switched_off', actor: { kind: 'td' } })).toThrow()
  })
})
