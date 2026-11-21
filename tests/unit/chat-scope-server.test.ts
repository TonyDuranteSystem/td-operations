import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin: account_contacts.select('contact_id').is('access_revoked_at', null).eq('account_id', X)
// resolves to a configurable rows array. `isCalls` records the no-portal-access filter (dev job beb43385).
let rows: { contact_id: string }[] = []
const isCalls: unknown[][] = []
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        is: (...args: unknown[]) => {
          isCalls.push(args)
          return { eq: async () => ({ data: rows }) }
        },
      }),
    }),
  },
}))

// The viewer's own companies and company-being-set-up come from lib/portal/queries (the SAME inputs the chat entity list uses).
let membership = { accounts: [], membersByAccount: new Map<string, string[]>(), hasSoleOwned: true, hasShared: false }
let formations: unknown[] = []
vi.mock('@/lib/portal/queries', () => ({
  getChatMembership: vi.fn(async () => membership),
  getInProgressFormations: vi.fn(async () => formations),
}))

import { resolvePersonalNullInclusion } from '@/lib/portal/chat-scope-server'

describe('resolvePersonalNullInclusion (privacy choke point)', () => {
  beforeEach(() => {
    rows = []
    membership = { accounts: [], membersByAccount: new Map(), hasSoleOwned: true, hasShared: false }
    formations = []
  })

  it('counts only members who can open the company (a member with no portal access is left out)', async () => {
    isCalls.length = 0
    rows = [{ contact_id: 'me' }]
    await resolvePersonalNullInclusion('acct', 'me')
    expect(isCalls).toContainEqual(['access_revoked_at', null])
  })

  it('true when the account has exactly one linked contact == the viewer (sole-owned SMLLC)', async () => {
    rows = [{ contact_id: 'me' }]
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(true)
  })

  it('false for a multi-member account, even if the viewer is one of them (MMLLC)', async () => {
    rows = [{ contact_id: 'me' }, { contact_id: 'other' }]
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(false)
  })

  it('false when the single linked contact is someone else', async () => {
    rows = [{ contact_id: 'other' }]
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(false)
  })

  it('false when the account has no linked contacts', async () => {
    rows = []
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(false)
  })

  // dev job 58cb7a82: a client who owns a company alone AND belongs to a shared one has a separate personal chat, so their
  // private messages leave the solo company's chat (a message never shows in two places).
  it('false for a company owned alone when the viewer ALSO belongs to a shared company', async () => {
    rows = [{ contact_id: 'me' }]
    membership = { ...membership, hasSoleOwned: true, hasShared: true }
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(false)
  })

  it('true again when a company being set up already hosts the private messages', async () => {
    rows = [{ contact_id: 'me' }]
    membership = { ...membership, hasSoleOwned: true, hasShared: true }
    formations = [{ id: 'f1' }]
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(true)
  })

  it('a viewer with only companies owned alone keeps seeing private messages inside them', async () => {
    rows = [{ contact_id: 'me' }]
    membership = { ...membership, hasSoleOwned: true, hasShared: false }
    expect(await resolvePersonalNullInclusion('acct', 'me')).toBe(true)
  })
})
