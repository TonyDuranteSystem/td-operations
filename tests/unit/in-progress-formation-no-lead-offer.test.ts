import { describe, it, expect, vi } from 'vitest'

/**
 * S1 (2026-09-27) bug-hunter blocker: an existing client whose FIRST company
 * came through a formation lead buys a NEW company on their contact page (no
 * lead). The new company's in-progress entry must point at its OFFER — never
 * borrow the first company's lead (that sent the wizard to the old company).
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { getInProgressFormations } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'

function install(sds: Array<Record<string, unknown>>, offers: Array<Record<string, unknown>>, leads: Array<{ id: string }>) {
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const rows = table === 'service_deliveries' ? sds : table === 'offers' ? offers : table === 'leads' ? leads : []
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, is: () => chain, or: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    }
    return chain
  }) as never)
}

describe('getInProgressFormations — lead-less new-company offer', () => {
  it('does NOT borrow the first company\'s lead; anchors on the new offer', async () => {
    install(
      [{ id: 'sd-new', service_name: 'Company Formation - New Co', notes: null, source_offer_token: 'tok-new', name_checks: null }],
      [
        { id: 'offer-new', token: 'tok-new', lead_id: null, created_at: '2026-09-27' },
        { id: 'offer-old', token: 'tok-old', lead_id: 'lead-old', created_at: '2026-01-01' },
      ],
      [{ id: 'lead-old' }],
    )
    const [f] = await getInProgressFormations('contact-1')
    expect(f.leadId).toBeNull()
    expect(f.offerId).toBe('offer-new')
  })

  it('same when only the notes carry the new offer token', async () => {
    install(
      [{ id: 'sd-new', service_name: 'Company Formation - New Co', notes: 'Auto-created from offer tok-new', source_offer_token: null, name_checks: null }],
      [
        { id: 'offer-new', token: 'tok-new', lead_id: null, created_at: '2026-09-27' },
        { id: 'offer-old', token: 'tok-old', lead_id: 'lead-old', created_at: '2026-01-01' },
      ],
      [{ id: 'lead-old' }],
    )
    const [f] = await getInProgressFormations('contact-1')
    expect(f.leadId).toBeNull()
    expect(f.offerId).toBe('offer-new')
  })

  it('first-time client: the real lead still wins (unchanged)', async () => {
    install(
      [{ id: 'sd-1', service_name: 'Company Formation - First Co', notes: null, source_offer_token: 'tok-1', name_checks: null }],
      [{ id: 'offer-1', token: 'tok-1', lead_id: 'lead-1', created_at: '2026-09-27' }],
      [{ id: 'lead-1' }],
    )
    const [f] = await getInProgressFormations('contact-1')
    expect(f.leadId).toBe('lead-1')
  })

  it('unknown token + single formation keeps the legacy single-lead fallback', async () => {
    install(
      [{ id: 'sd-1', service_name: 'Company Formation - First Co', notes: null, source_offer_token: null, name_checks: null }],
      [{ id: 'offer-1', token: 'tok-1', lead_id: 'lead-1', created_at: '2026-09-27' }],
      [{ id: 'lead-1' }],
    )
    const [f] = await getInProgressFormations('contact-1')
    expect(f.leadId).toBe('lead-1')
  })
})
