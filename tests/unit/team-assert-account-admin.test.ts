import { describe, it, expect, vi, beforeEach } from 'vitest'

const { resolveIdentity, isAdmin } = vi.hoisted(() => ({ resolveIdentity: vi.fn(), isAdmin: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: {} }))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: resolveIdentity }))
vi.mock('@/lib/portal/team/account-admin', () => ({ isAccountAdmin: isAdmin }))

import { assertAccountAdmin } from '@/lib/portal/team/server'
import type { User } from '@supabase/supabase-js'

const user = { id: 'u1' } as User

beforeEach(() => { vi.clearAllMocks() })

describe('assertAccountAdmin (who may use the team routes)', () => {
  it('a current owner/member of a company that is one of their own companies: allowed, returns their contact id', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'contact', contactId: 'C1', accountIds: ['A1', 'A2'] })
    isAdmin.mockResolvedValue(true)
    expect(await assertAccountAdmin(user, 'A1')).toBe('C1')
    expect(isAdmin).toHaveBeenCalledWith('C1', 'A1')
  })
  it('refuses a company that is not one of the person\'s own — without even asking the owner rule', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'contact', contactId: 'C1', accountIds: ['A2'] })
    isAdmin.mockResolvedValue(true)
    expect(await assertAccountAdmin(user, 'A1')).toBeNull()
    expect(isAdmin).not.toHaveBeenCalled()
  })
  it('refuses when the owner rule says no (representative, departed member, stray link)', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'contact', contactId: 'C1', accountIds: ['A1'] })
    isAdmin.mockResolvedValue(false)
    expect(await assertAccountAdmin(user, 'A1')).toBeNull()
  })
  it('a team login can NEVER manage the team, whatever it holds', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'teammate', teamMemberId: 't', accountId: 'A1', capabilities: { documents: true } })
    isAdmin.mockResolvedValue(true)
    expect(await assertAccountAdmin(user, 'A1')).toBeNull()
    expect(isAdmin).not.toHaveBeenCalled()
  })
  it('no identity and no company: refused', async () => {
    resolveIdentity.mockResolvedValue({ kind: 'none' })
    expect(await assertAccountAdmin(user, 'A1')).toBeNull()
    expect(await assertAccountAdmin(user, '')).toBeNull()
  })
})
