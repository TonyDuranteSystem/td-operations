import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression guard for the 2026-07-06 dedup change: emitClientChatEvent must
 * dedup on the marker ALONE (kind + source table:id), never additionally on
 * the recipient tags — an older copy of the same event may carry different
 * tags (account-only rows written before dual-tagging) and a webhook retry
 * must not double-post.
 */

// Chainable supabaseAdmin mock. `existingRow` controls the dedup pre-check
// result; `inserted` captures the insert payload; `recipientFiltered` flips
// true if the dedup query ever filters by contact_id/account_id.
let existingRow: { id: string } | null = null
let inserted: Record<string, unknown> | null = null
let recipientFiltered = false

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
    eq: (col: string) => {
      if (col === 'contact_id' || col === 'account_id') recipientFiltered = true
      return chain
    },
    like: () => chain,
    is: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: existingRow }),
  }
  return chain
}

import { emitClientChatEvent } from '@/lib/portal/chat-events'

describe('emitClientChatEvent dedup', () => {
  beforeEach(() => {
    existingRow = null
    inserted = null
    recipientFiltered = false
  })

  const params = {
    contact_id: 'c1',
    account_id: 'a1',
    topic: 'Members',
    message: 'The client submitted the member information form.',
    source: { table: 'member_info_requests', id: 'req-1' },
    event_kind: 'members_updated' as const,
  }

  it('skips the insert when a row with the same marker exists — regardless of its recipient tags', async () => {
    existingRow = { id: 'old-account-only-note' }
    const result = await emitClientChatEvent(params)
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('already_emitted')
    expect(result.message_id).toBe('old-account-only-note')
    expect(inserted).toBeNull()
  })

  it('never narrows the dedup lookup by contact_id/account_id', async () => {
    existingRow = { id: 'x' }
    await emitClientChatEvent(params)
    expect(recipientFiltered).toBe(false)
  })

  it('inserts with both recipient tags, a null topic, and the marker in the body', async () => {
    const result = await emitClientChatEvent(params)
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({
      contact_id: 'c1',
      account_id: 'a1',
      sender_type: 'system',
      topic: null,
    })
    expect(String(inserted?.message)).toContain(
      '<!-- chat-event: kind=members_updated src=member_info_requests:req-1 -->',
    )
  })

  it('refuses to emit with no recipient at all', async () => {
    const result = await emitClientChatEvent({ ...params, contact_id: null, account_id: null })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('missing_recipient')
    expect(inserted).toBeNull()
  })
})
