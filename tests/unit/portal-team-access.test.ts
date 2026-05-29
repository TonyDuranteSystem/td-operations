import { describe, it, expect } from 'vitest'
import { normalizeCapabilities, hasCapability } from '@/lib/portal/team/capabilities'
import { resolvePortalIdentity, type ResolveDeps } from '@/lib/portal/resolve-portal-identity'
import type { User } from '@supabase/supabase-js'

// ── capability model ─────────────────────────────────────────────
describe('normalizeCapabilities', () => {
  it('keeps only known keys with value true', () => {
    expect(normalizeCapabilities({ documents: true, chat: true, bogus: true, invoices_billing: false }))
      .toEqual({ documents: true, chat: true })
  })
  it('drops non-true values (default-deny)', () => {
    expect(normalizeCapabilities({ documents: 'yes', chat: 1, company_services: false })).toEqual({})
  })
  it('handles null/garbage input', () => {
    expect(normalizeCapabilities(null)).toEqual({})
    expect(normalizeCapabilities('nope')).toEqual({})
    expect(normalizeCapabilities(undefined)).toEqual({})
  })
})

describe('hasCapability (default-deny)', () => {
  it('true only when explicitly granted', () => {
    expect(hasCapability({ documents: true }, 'documents')).toBe(true)
    expect(hasCapability({ documents: true }, 'chat')).toBe(false)
    expect(hasCapability({}, 'documents')).toBe(false)
    expect(hasCapability(null, 'documents')).toBe(false)
    expect(hasCapability(undefined, 'chat')).toBe(false)
  })
})

// ── identity resolver ────────────────────────────────────────────
function makeUser(app_metadata: Record<string, unknown>, id = 'auth-1'): User {
  return { id, app_metadata } as unknown as User
}

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    fetchTeamMemberByAuthId: async () => null,
    getContactId: () => null,
    getAccountIds: async () => [],
    ...over,
  }
}

describe('resolvePortalIdentity', () => {
  it('resolves a normal client contact', async () => {
    const id = await resolvePortalIdentity(
      makeUser({ role: 'client', contact_id: 'c1' }),
      deps({ getContactId: () => 'c1', getAccountIds: async () => ['a1', 'a2'] }),
    )
    expect(id).toEqual({ kind: 'contact', contactId: 'c1', accountIds: ['a1', 'a2'] })
  })

  it('resolves an active teammate with fresh capabilities from the table', async () => {
    const id = await resolvePortalIdentity(
      makeUser({ role: 'client', kind: 'team_member' }),
      deps({
        fetchTeamMemberByAuthId: async () => ({
          id: 'tm1', account_id: 'a9', display_name: 'Mario', email: null,
          capabilities: { documents: true, bogus: true }, status: 'active',
        }),
      }),
    )
    expect(id).toEqual({
      kind: 'teammate', teamMemberId: 'tm1', accountId: 'a9',
      displayName: 'Mario', email: null, capabilities: { documents: true },
    })
  })

  it('DENIES a revoked teammate (deny-by-default)', async () => {
    const id = await resolvePortalIdentity(
      makeUser({ role: 'client', kind: 'team_member' }),
      deps({
        fetchTeamMemberByAuthId: async () => ({
          id: 'tm1', account_id: 'a9', display_name: 'Mario', email: null,
          capabilities: { documents: true }, status: 'revoked',
        }),
      }),
    )
    expect(id).toEqual({ kind: 'none' })
  })

  it('DENIES a teammate marker with no matching row', async () => {
    const id = await resolvePortalIdentity(
      makeUser({ role: 'client', kind: 'team_member' }),
      deps({ fetchTeamMemberByAuthId: async () => null }),
    )
    expect(id).toEqual({ kind: 'none' })
  })

  it('returns none when neither contact nor teammate resolves (deny-by-default)', async () => {
    const id = await resolvePortalIdentity(makeUser({ role: 'client' }), deps())
    expect(id).toEqual({ kind: 'none' })
  })

  it('never calls the teammate path for a plain contact (no kind marker)', async () => {
    let teamFetched = false
    const id = await resolvePortalIdentity(
      makeUser({ role: 'client', contact_id: 'c1' }),
      deps({
        getContactId: () => 'c1',
        getAccountIds: async () => ['a1'],
        fetchTeamMemberByAuthId: async () => { teamFetched = true; return null },
      }),
    )
    expect(teamFetched).toBe(false)
    expect(id.kind).toBe('contact')
  })
})
