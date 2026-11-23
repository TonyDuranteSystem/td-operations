import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  validateTeammateInput,
  generateTeammateEmail,
  provisionTeammate,
  companyMemberMessage,
  isDuplicateError,
  type TeammateInput,
  type ProvisionDeps,
} from '@/lib/portal/team/provision'

// No email and no password in the invite: the system makes the password, the login address is always a hidden placeholder.
const valid: TeammateInput = {
  accountId: 'a1',
  username: 'mario.rossi',
  displayName: 'Mario Rossi',
  capabilities: { documents: true, chat: true, bogus: true },
  createdByContactId: 'admin1',
  disclaimerAccepted: true,
}

describe('validateTeammateInput', () => {
  it('accepts a valid input and normalizes capabilities', () => {
    const { errors, value } = validateTeammateInput(valid)
    expect(errors).toEqual([])
    expect(value?.capabilities).toEqual({ documents: true, chat: true })
    expect(value?.displayName).toBe('Mario Rossi')
  })

  it('a blank username is allowed (the system suggests one)', () => {
    expect(validateTeammateInput({ ...valid, username: '' }).errors).toEqual([])
    expect(validateTeammateInput({ ...valid, username: null }).errors).toEqual([])
  })

  it('requires the name, a valid username when given, and the disclaimer', () => {
    expect(validateTeammateInput({ ...valid, displayName: '  ' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, username: 'ab' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, username: 'has space' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, disclaimerAccepted: false }).errors).toContain('The responsibility disclaimer must be accepted')
  })
})

describe('generateTeammateEmail', () => {
  it('is a non-deliverable placeholder', () => {
    expect(generateTeammateEmail('abc')).toBe('tm-abc@teammate.portal.tonydurante.us')
  })
})

describe('provisionTeammate: no email, system password', () => {
  const calls: Array<{ kind: string; arg?: unknown }> = []
  const deps = (over: Partial<ProvisionDeps> = {}): ProvisionDeps => ({
    usernameTaken: async () => false,
    createAuthUser: async (p) => { calls.push({ kind: 'auth', arg: p }); return { id: 'u1' } },
    insertTeamMember: async (r) => { calls.push({ kind: 'row', arg: r }); return { id: 't1' } },
    newToken: () => 'tok123',
    makePassword: () => 'Abcd-Efgh-Jkmn',
    ...over,
  })

  it('creates a login with the hidden placeholder address, a must-change-password flag and NO email on the team entry', async () => {
    calls.length = 0
    const r = await provisionTeammate(valid, deps())
    expect(r).toMatchObject({ ok: true, teamMemberId: 't1', username: 'mario.rossi', password: 'Abcd-Efgh-Jkmn' })
    const auth = calls.find(c => c.kind === 'auth')!.arg as { email: string; password: string; userMetadata: Record<string, unknown>; appMetadata: Record<string, unknown> }
    expect(auth.email).toBe('tm-tok123@teammate.portal.tonydurante.us')
    expect(auth.password).toBe('Abcd-Efgh-Jkmn')
    expect(auth.userMetadata.must_change_password).toBe(true)
    expect(auth.appMetadata.kind).toBe('team_member')
    const row = calls.find(c => c.kind === 'row')!.arg as { email: string | null; username: string }
    expect(row.email).toBeNull()
  })

  it('suggests a username from the name when none is given, skipping taken ones', async () => {
    const taken = new Set(['marco.rossi'])
    const r = await provisionTeammate({ ...valid, username: '', displayName: 'Marco Rossi' }, deps({ usernameTaken: async (u) => taken.has(u) }))
    expect(r.ok).toBe(true)
    expect(r.username).toBe('marco.rossi2')
  })

  it('refuses a username that is already taken', async () => {
    const r = await provisionTeammate(valid, deps({ usernameTaken: async () => true }))
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toContain('already taken')
  })

  it('rejects invalid input before any side effect', async () => {
    calls.length = 0
    const r = await provisionTeammate({ ...valid, disclaimerAccepted: false }, deps())
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('stops, creating nothing, when the name belongs to a Member of the company (they get their own full login)', async () => {
    calls.length = 0
    const r = await provisionTeammate(valid, deps({ findCompanyMemberByName: async () => ({ name: 'Mario Rossi', role: 'Member' }) }))
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toContain('Stop: this person is already a member of this company (Mario Rossi, Member)')
    expect(r.errors?.[0]).toContain('contact support')
    expect(calls).toEqual([])
  })

  it('companyMemberMessage works without a name or role', () => {
    expect(companyMemberMessage({ name: null, role: null })).toContain('Stop: this person is already a member of this company.')
  })

  it('the real wiring has no email deps and checks members by name', () => {
    const src = readFileSync('lib/portal/team/server.ts', 'utf8')
    expect(src).toContain('findCompanyMemberByName')
    expect(src).not.toContain('findAuthUserByEmail')
    expect(src).not.toContain('emailHasLogin')
  })
})

describe('provisionTeammate: adding is all-or-nothing (step 2)', () => {
  const log: string[] = []
  const base = (over: Partial<ProvisionDeps> = {}): ProvisionDeps => ({
    usernameTaken: async () => false,
    createAuthUser: async () => { log.push('auth-created'); return { id: 'u1' } },
    insertTeamMember: async () => { log.push('row-inserted'); return { id: 't1' } },
    deleteAuthUser: async (id) => { log.push('auth-deleted:' + id) },
    deleteTeamMember: async (id) => { log.push('row-deleted:' + id) },
    recordAdded: async () => { log.push('recorded') },
    newToken: () => 'tok',
    makePassword: () => 'Abcd-Efgh-Jkmn',
    ...over,
  })

  it('happy path: login, entry, then the record — in that order, nothing undone', async () => {
    log.length = 0
    const r = await provisionTeammate({ ...valid, noticeVersion: 'v1', ip: '1.2.3.4' }, base())
    expect(r).toMatchObject({ ok: true, teamMemberId: 't1' })
    expect(log).toEqual(['auth-created', 'row-inserted', 'recorded'])
  })

  it('the record carries who, the powers, the notice version and the address', async () => {
    let seen: unknown
    await provisionTeammate({ ...valid, noticeVersion: 'v1', ip: '1.2.3.4' }, base({ recordAdded: async (i) => { seen = i } }))
    expect(seen).toMatchObject({ teamMemberId: 't1', accountId: 'a1', createdByContactId: 'admin1', username: 'mario.rossi', capabilities: { documents: true, chat: true }, noticeVersion: 'v1', ip: '1.2.3.4' })
  })

  it('passes the accepted notice to the stored row, and only when there is one', async () => {
    const rows: Array<Record<string, unknown>> = []
    const d = base({ insertTeamMember: async (r) => { rows.push(r as unknown as Record<string, unknown>); return { id: 't1' } } })
    await provisionTeammate({ ...valid, noticeVersion: 'v1', ip: '1.2.3.4' }, d)
    await provisionTeammate(valid, d)
    expect(rows[0]).toMatchObject({ notice_version: 'v1', notice_accepted_ip: '1.2.3.4' })
    expect(rows[1]).toMatchObject({ notice_version: null, notice_accepted_ip: null })
  })

  it('DOUBLE CLICK: the second add loses on the unique rule — its login is deleted, no orphan, plain message', async () => {
    log.length = 0
    const r = await provisionTeammate(valid, base({ insertTeamMember: async () => { throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }) } }))
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toContain('already taken')
    expect(log).toEqual(['auth-created', 'auth-deleted:u1'])
  })

  it('any other failure saving the entry also deletes the login, then reports the error', async () => {
    log.length = 0
    await expect(provisionTeammate(valid, base({ insertTeamMember: async () => { throw new Error('db down') } }))).rejects.toThrow('db down')
    expect(log).toEqual(['auth-created', 'auth-deleted:u1'])
  })

  it('NO RECORD, NO GRANT: when the record cannot be saved, the entry AND the login are deleted and nothing is created', async () => {
    log.length = 0
    const r = await provisionTeammate(valid, base({ recordAdded: async () => { throw new Error('log down') } }))
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toContain('could not save the record')
    expect(r.password).toBeUndefined()
    expect(log).toEqual(['auth-created', 'row-inserted', 'row-deleted:t1', 'auth-deleted:u1'])
  })

  it('an undo that itself fails does not hide the original problem — and the message no longer claims "nothing was created"', async () => {
    const r = await provisionTeammate(valid, base({ recordAdded: async () => { throw new Error('log down') }, deleteAuthUser: async () => { throw new Error('cannot delete') }, deleteTeamMember: async () => { throw new Error('cannot delete') } }))
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]).toContain('could not be fully removed')
    expect(r.errors?.[0]).not.toContain('nothing was created')
    expect(r.errors?.[0]).toContain('contact support')
  })
  it('one failed undo step is enough to stop saying "nothing was created"', async () => {
    const onlyLogin = await provisionTeammate(valid, base({ recordAdded: async () => { throw new Error('log down') }, deleteAuthUser: async () => { throw new Error('cannot delete') } }))
    expect(onlyLogin.errors?.[0]).toContain('could not be fully removed')
    const onlyEntry = await provisionTeammate(valid, base({ recordAdded: async () => { throw new Error('log down') }, deleteTeamMember: async () => { throw new Error('cannot delete') } }))
    expect(onlyEntry.errors?.[0]).toContain('could not be fully removed')
  })

  it('the database "already exists" refusal is recognised by code or by text', () => {
    expect(isDuplicateError({ code: '23505' })).toBe(true)
    expect(isDuplicateError(new Error('duplicate key value violates unique constraint "uq_portal_team_members_username"'))).toBe(true)
    expect(isDuplicateError(new Error('db down'))).toBe(false)
    expect(isDuplicateError(null)).toBe(false)
  })
})

describe('usernames (bug-hunt fixes)', () => {
  it('escapeLikePattern makes _ % and \\ literal, so a_b can never match a.b', async () => {
    const { escapeLikePattern } = await import('@/lib/portal/team/credentials')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('marco.rossi')).toBe('marco.rossi')
  })
  it('suggestUsername never hands back a random ending nobody checked', async () => {
    const { suggestUsername } = await import('@/lib/portal/team/credentials')
    const asked: string[] = []
    // every plain candidate is taken; the random endings are free
    const name = await suggestUsername('Marco Rossi', async (u) => { asked.push(u); return !/\d{4}$/.test(u) })
    expect(/^marco\.rossi\d{4}$/.test(name)).toBe(true)
    expect(asked).toContain(name)
    await expect(suggestUsername('Marco Rossi', async () => true)).rejects.toThrow(/free username/)
  })
  it('a name with no Latin letters still gets a usable username', async () => {
    const { suggestUsername } = await import('@/lib/portal/team/credentials')
    expect(await suggestUsername('张伟', async () => false)).toBe('team')
  })
})
