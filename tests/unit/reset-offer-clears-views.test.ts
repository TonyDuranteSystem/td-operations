/**
 * POST /api/crm/admin-actions/reset-offer — a draft has no client history (dev job b834e4ae).
 *
 * Reset used to put an offer back to 'draft' but leave view_count/viewed_at behind, so the next
 * send lit "Viewed" on the lead before the client had opened anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'a1', email: 'admin@tonydurante.us' } }, error: null }) },
  }),
}))
vi.mock('@/lib/permissions', () => ({ canPerform: () => true }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/operations/cancel-offer-payments', () => ({
  cancelPaymentsForOfferTokens: vi.fn().mockResolvedValue({ ok: true, cancelled: 0, blocked_paid: [] }),
}))

let offerUpdates: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'offers') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { token: 't', lead_id: 'l1', client_name: 'X', status: 'viewed', view_count: 3, viewed_at: '2026-10-05T15:54:39Z' }, error: null }) }) }),
          update: (payload: Record<string, unknown>) => {
            offerUpdates.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'leads') {
        return { update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }) }
      }
      return { delete: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }
    },
  },
}))

import { POST } from '@/app/api/crm/admin-actions/reset-offer/route'
import { logAction } from '@/lib/mcp/action-log'

beforeEach(() => { offerUpdates = []; vi.mocked(logAction).mockClear() })

describe('reset-offer', () => {
  it('returns the offer to draft AND clears the view counters', async () => {
    const res = await POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ offer_token: 't' }) }))
    expect(res.status).toBe(200)
    expect(offerUpdates).toHaveLength(1)
    expect(offerUpdates[0]).toMatchObject({ status: 'draft', payment_links: null, view_count: 0, viewed_at: null })
  })

  it('keeps what the counters were in the audit log, since the reset wipes them', async () => {
    await POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ offer_token: 't' }) }))
    const call = vi.mocked(logAction).mock.calls[0][0] as { details: Record<string, unknown> }
    expect(call.details).toMatchObject({ previous_status: 'viewed', previous_view_count: 3, previous_viewed_at: '2026-10-05T15:54:39Z' })
  })
})
