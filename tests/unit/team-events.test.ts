import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TEAM_EVENTS,
  TEAM_ACTOR_KINDS,
  buildTeamEventRow,
  recordTeamEvent,
  recordTeamEventBestEffort,
  ownerActorFromRequest,
  powersGrew,
  type TeamEventDb,
} from '@/lib/portal/team/events'

const MIGRATION = 'scripts/migrations/20261117-2300-team-foundation.sql'
const owner = { kind: 'owner' as const, contactId: 'c1', ip: ' 10.0.0.1 ' }
const base = { teamMemberId: 'tm1', accountId: 'a1', event: 'added' as const, actor: owner }

const okDb = (): TeamEventDb & { rows: unknown[] } => {
  const rows: unknown[] = []
  return { rows, from: () => ({ insert: async (r) => { rows.push(r); return { error: null } } }) }
}
const failingDb: TeamEventDb = { from: () => ({ insert: async () => ({ error: { message: 'boom' } }) }) }

describe('buildTeamEventRow', () => {
  it('builds an owner row with the owner id and a trimmed address', () => {
    expect(buildTeamEventRow({ ...base, detail: { x: 1 } })).toEqual({
      team_member_id: 'tm1', account_id: 'a1', event: 'added', actor_kind: 'owner',
      actor_contact_id: 'c1', actor_staff_email: null, detail: { x: 1 }, ip: '10.0.0.1',
    })
  })
  it('builds a TD row with the staff login and no owner id', () => {
    const r = buildTeamEventRow({ ...base, event: 'switched_off', actor: { kind: 'td', staffEmail: 'luca@tonydurante.us', contactId: 'ignored' } })
    expect(r).toMatchObject({ actor_kind: 'td', actor_staff_email: 'luca@tonydurante.us', actor_contact_id: null })
  })
  it('refuses an owner action with no owner, a TD action with no staff login, an unknown event or actor, a missing member/company', () => {
    expect(() => buildTeamEventRow({ ...base, actor: { kind: 'owner' } })).toThrow(/which owner/)
    expect(() => buildTeamEventRow({ ...base, actor: { kind: 'td' } })).toThrow(/staff login/)
    expect(() => buildTeamEventRow({ ...base, event: 'exploded' as never })).toThrow(/Unknown team event/)
    expect(() => buildTeamEventRow({ ...base, actor: { kind: 'robot' as never } })).toThrow(/Unknown team actor/)
    expect(() => buildTeamEventRow({ ...base, teamMemberId: '' })).toThrow()
    expect(() => buildTeamEventRow({ ...base, accountId: '' })).toThrow()
  })
  it('keeps the system actor without a person', () => {
    expect(buildTeamEventRow({ ...base, event: 'migrated', actor: { kind: 'system' } })).toMatchObject({ actor_kind: 'system', actor_contact_id: null, ip: null })
  })
  it('cuts an overlong address', () => {
    expect(buildTeamEventRow({ ...base, actor: { ...owner, ip: 'x'.repeat(200) } }).ip).toHaveLength(64)
  })
})

describe('recordTeamEvent / recordTeamEventBestEffort', () => {
  it('strict: saves the row', async () => {
    const db = okDb()
    await recordTeamEvent(db, base)
    expect(db.rows).toHaveLength(1)
  })
  it('strict: throws when the database refuses', async () => {
    await expect(recordTeamEvent(failingDb, base)).rejects.toThrow(/Could not save the team record/)
  })
  it('best effort: never throws, says whether it saved', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await recordTeamEventBestEffort(okDb(), base)).toBe(true)
    expect(await recordTeamEventBestEffort(failingDb, base)).toBe(false)
    expect(await recordTeamEventBestEffort(okDb(), { ...base, actor: { kind: 'owner' } })).toBe(false)
    spy.mockRestore()
  })
})

describe('ownerActorFromRequest + powersGrew', () => {
  it('takes the first forwarded address', () => {
    const h = { get: (n: string) => (n === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : null) }
    expect(ownerActorFromRequest('c9', h)).toEqual({ kind: 'owner', contactId: 'c9', ip: '1.2.3.4' })
    expect(ownerActorFromRequest('c9', { get: () => null }).ip).toBeNull()
  })
  it('powersGrew is true only when a power is ADDED', () => {
    expect(powersGrew({ chat: true }, { chat: true, documents: true })).toBe(true)
    expect(powersGrew({ chat: true, documents: true }, { chat: true })).toBe(false)
    expect(powersGrew({ chat: true }, { chat: true })).toBe(false)
    expect(powersGrew(null, { chat: true })).toBe(true)
    expect(powersGrew({ chat: true }, null)).toBe(false)
    expect(powersGrew({}, { chat: false })).toBe(false)
  })
})

describe('the migration and this code agree', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  const listIn = (re: RegExp): string[] => {
    const m = sql.match(re)
    expect(m, String(re)).toBeTruthy()
    return [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])
  }
  it('the database trigger allows exactly the events listed here', () => {
    expect(listIn(/NEW\.event NOT IN \(([^)]*)\)/).sort()).toEqual([...TEAM_EVENTS].sort())
  })
  it('the database trigger allows exactly the actor kinds listed here', () => {
    expect(listIn(/NEW\.actor_kind NOT IN \(([^)]*)\)/).sort()).toEqual([...TEAM_ACTOR_KINDS].sort())
  })
  it('refuses to change or delete a row, and to empty the table', () => {
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON portal_team_events/)
    expect(sql).toMatch(/BEFORE TRUNCATE ON portal_team_events/)
    expect(sql).toMatch(/append-only/)
  })
  it('has NO foreign key on the event table (deleting a company or person must never erase the history)', () => {
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS portal_team_events'), sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS portal_team_events')))
    expect(table).not.toMatch(/REFERENCES/i)
  })
  it('adds no value-list CHECK and no new status value (keeps the shared sandbox checks untouched)', () => {
    expect(sql).not.toMatch(/=\s*ANY\s*\(\s*ARRAY/i)
    expect(sql).not.toMatch(/chk_ptm_status/)
    expect(sql).toMatch(/switched_off_by ~ '\^\(owner\|td\)\$'/)
    // a NULL slips past a regex test, so the stamp must also demand "who" explicitly
    expect(sql).toMatch(/switched_off_at IS NOT NULL AND switched_off_by IS NOT NULL AND switched_off_by ~/)
  })
})
