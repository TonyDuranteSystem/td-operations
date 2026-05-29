import { describe, it, expect } from 'vitest'
import {
  validateTeammateInput,
  generateTeammateEmail,
  provisionTeammate,
  type TeammateInput,
  type ProvisionDeps,
} from '@/lib/portal/team/provision'

const valid: TeammateInput = {
  accountId: 'a1',
  username: 'mario.rossi',
  displayName: 'Mario Rossi',
  password: 'secret123',
  email: null,
  capabilities: { documents: true, chat: true, bogus: true },
  createdByContactId: 'admin1',
  disclaimerAccepted: true,
}

describe('validateTeammateInput', () => {
  it('accepts a valid input and normalizes capabilities + display name', () => {
    const { errors, value } = validateTeammateInput(valid)
    expect(errors).toEqual([])
    expect(value?.capabilities).toEqual({ documents: true, chat: true })
    expect(value?.displayName).toBe('Mario Rossi')
    expect(value?.email).toBeNull()
  })

  it('defaults display name to username when blank', () => {
    expect(validateTeammateInput({ ...valid, displayName: '   ' }).value?.displayName).toBe('mario.rossi')
  })

  it('rejects bad username / short password / missing disclaimer / bad email', () => {
    expect(validateTeammateInput({ ...valid, username: 'ab' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, username: 'has space' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, password: 'short' }).errors.length).toBeGreaterThan(0)
    expect(validateTeammateInput({ ...valid, disclaimerAccepted: false }).errors).toContain('The responsibility disclaimer must be accepted')
    expect(validateTeammateInput({ ...valid, email: 'notanemail' }).errors).toContain('Email is not valid')
  })

  it('accepts a valid optional email', () => {
    expect(validateTeammateInput({ ...valid, email: 'm@x.com' }).value?.email).toBe('m@x.com')
  })
})

describe('generateTeammateEmail', () => {
  it('is namespaced + uses the token', () => {
    expect(generateTeammateEmail('abc')).toBe('tm-abc@teammate.portal.tonydurante.us')
  })
})

describe('provisionTeammate', () => {
  function deps(over: Partial<ProvisionDeps> = {}): { deps: ProvisionDeps; calls: Record<string, unknown> } {
    const calls: Record<string, unknown> = {}
    return {
      calls,
      deps: {
        usernameTaken: async () => false,
        createAuthUser: async (p) => { calls.auth = p; return { id: 'auth-1' } },
        insertTeamMember: async (r) => { calls.row = r; return { id: 'tm-1' } },
        newToken: () => 'TOK',
        ...over,
      },
    }
  }

  it('creates auth user (placeholder email) + grant row when no email given', async () => {
    const { deps: d, calls } = deps()
    const res = await provisionTeammate(valid, d)
    expect(res).toEqual({ ok: true, teamMemberId: 'tm-1' })
    expect((calls.auth as { email: string }).email).toBe('tm-TOK@teammate.portal.tonydurante.us')
    expect((calls.auth as { appMetadata: Record<string, unknown> }).appMetadata).toMatchObject({ role: 'client', kind: 'team_member', account_id: 'a1' })
    expect((calls.row as { capabilities: unknown }).capabilities).toEqual({ documents: true, chat: true })
  })

  it('uses the real email as auth email when provided', async () => {
    const { deps: d, calls } = deps()
    await provisionTeammate({ ...valid, email: 'real@x.com' }, d)
    expect((calls.auth as { email: string }).email).toBe('real@x.com')
    expect((calls.row as { email: string | null }).email).toBe('real@x.com')
  })

  it('rejects a taken username before creating anything', async () => {
    let created = false
    const { deps: d } = deps({ usernameTaken: async () => true, createAuthUser: async () => { created = true; return { id: 'x' } } })
    const res = await provisionTeammate(valid, d)
    expect(res.ok).toBe(false)
    expect(res.errors).toContain('That username is already taken — pick another')
    expect(created).toBe(false)
  })

  it('rejects invalid input before any side effect', async () => {
    let created = false
    const { deps: d } = deps({ createAuthUser: async () => { created = true; return { id: 'x' } } })
    const res = await provisionTeammate({ ...valid, password: 'x' }, d)
    expect(res.ok).toBe(false)
    expect(created).toBe(false)
  })
})
