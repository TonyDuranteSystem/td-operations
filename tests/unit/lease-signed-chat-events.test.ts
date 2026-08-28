import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Regression guard for dev job c3efa6cb: signing the lease must produce a
 * marked, What's-New-visible chat note — found missing entirely during a
 * full audit of client-action notifications (10 real lease signings in the
 * trailing 90 days, zero staff alerts).
 */

let existingRow: { id: string } | null = null
let inserted: Record<string, unknown> | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => makeSelectChain(),
      insert: (row: Record<string, unknown>) => {
        inserted = row
        return {
          select: () => ({
            single: async () => ({ data: { id: 'new-msg-id' }, error: null }),
          }),
        }
      },
    }),
  },
}))

function makeSelectChain() {
  const chain = {
    eq: () => chain,
    like: () => chain,
    is: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: existingRow }),
  }
  return chain
}

import { emitLeaseSignedEvent } from '@/lib/portal/chat-events'

describe('emitLeaseSignedEvent', () => {
  beforeEach(() => {
    existingRow = null
    inserted = null
  })

  it('emits under the lease_signed kind, scoped to the lease_agreements row, naming the suite', async () => {
    const result = await emitLeaseSignedEvent({
      lease_id: 'lease-1',
      account_id: 'acct-1',
      contact_id: null,
      company_name: 'Brixel LLC',
      suite_number: '101',
    })
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: 'acct-1', sender_type: 'system' })
    expect(String(inserted?.message)).toContain('Client signed the lease for Brixel LLC (Suite 101)')
    expect(String(inserted?.message)).toContain(
      '<!-- chat-event: kind=lease_signed src=lease_agreements:lease-1 -->',
    )
  })

  it('omits the suite clause when no suite number is on file', async () => {
    await emitLeaseSignedEvent({
      lease_id: 'lease-2',
      account_id: 'acct-2',
      company_name: 'Automatiko LLC',
    })
    expect(String(inserted?.message)).toContain('Client signed the lease for Automatiko LLC.')
    expect(String(inserted?.message)).not.toContain('Suite')
  })

  it('is skipped (already_emitted) when a note for the same lease already exists', async () => {
    existingRow = { id: 'old-note' }
    const result = await emitLeaseSignedEvent({
      lease_id: 'lease-1',
      account_id: 'acct-1',
      company_name: 'Brixel LLC',
    })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('already_emitted')
    expect(inserted).toBeNull()
  })
})
