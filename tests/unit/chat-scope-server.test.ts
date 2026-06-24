import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin: account_contacts.select('contact_id').eq('account_id', X)
// resolves to a configurable rows array.
let rows: { contact_id: string }[] = []
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: rows }),
      }),
    }),
  },
}))

import { resolvePersonalNullInclusion } from '@/lib/portal/chat-scope-server'

describe('resolvePersonalNullInclusion (privacy choke point)', () => {
  beforeEach(() => {
    rows = []
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
})
