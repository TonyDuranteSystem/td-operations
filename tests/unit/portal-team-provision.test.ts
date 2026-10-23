import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  validateTeammateInput,
  generateTeammateEmail,
  provisionTeammate,
  companyMemberMessage,
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
