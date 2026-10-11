import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The client sees FOUR addresses (Antonio 2026-10-10): Principal Office (official: 10225 Ulmerton Rd 3D, Largo — the same for
 * every client), Mailing Address (official + the company's own PMB), Registered Agent, Shipping Address (Seminole).
 * The first two are computed from the company's number whatever address row is saved; a company with no number yet keeps its
 * saved row.
 */

let account: Record<string, unknown>

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'eq']) chain[m] = self
      chain.single = () => Promise.resolve({ data: account, error: null })
      return chain
    },
  },
}))

import { getPortalAccountDetail } from '@/lib/portal/queries'

const WYOMING_ARTICLES = { address_line1: '30 N Gould St', address_line2: 'Ste R', city: 'Sheridan', state: 'WY', zip: '82801' }
const SEMINOLE = { address_line1: '11125 Park Blvd', address_line2: 'Suite 104-153', city: 'Seminole', state: 'FL', zip: '33772' }

beforeEach(() => {
  account = {
    id: 'a1', company_name: 'Acme LLC', suite_number: '3D-212', physical_address: null,
    registered_agent_address: null, registered_agent_provider: null,
    legal_address: WYOMING_ARTICLES, mailing_address: SEMINOLE, shipping_address: SEMINOLE, registered_agent: null,
  }
})

describe('getPortalAccountDetail — the Principal Office card', () => {
  it('shows the OFFICIAL address (no company number), even when the saved address is somewhere else', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.legal_address).toBe('10225 Ulmerton Rd 3D, Largo FL 33771')
    expect(d.legal_address_parts).toMatchObject({ address_line1: '10225 Ulmerton Rd 3D', address_line2: null, city: 'Largo', state: 'FL', zip: '33771' })
  })

  it('the Mailing Address card is the official address + the company\'s own PMB', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.mailing_card_address).toBe('10225 Ulmerton Rd 3D PMB 212, Largo FL 33771')
    expect(d.mailing_card_parts).toMatchObject({ address_line1: '10225 Ulmerton Rd 3D PMB 212', city: 'Largo' })
  })

  it('a wrongly linked Seminole mailing row no longer reaches any client card or the document address — documents the portal generates (Operating Agreement principal address) get the OFFICIAL address, no PMB', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.physical_address).toBe('10225 Ulmerton Rd 3D, Largo FL 33771')
    expect(d.physical_address).not.toContain('PMB')
  })

  it('a company with no number keeps its saved/legacy address for generated documents', async () => {
    account.suite_number = null
    account.physical_address = '99 Some St, Town'
    account.mailing_address = null
    const d = await getPortalAccountDetail('a1')
    expect(d.physical_address).toBe('99 Some St, Town')
  })

  it('the Shipping Address card is our Seminole office, whatever row the CRM has linked', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.shipping_address).toBe('11125 Park Blvd, Suite 104-153, Seminole FL 33772')
  })

  it('a company with no number yet has no Mailing card ("not on file")', async () => {
    account.suite_number = null
    const d = await getPortalAccountDetail('a1')
    expect(d.mailing_card_address).toBeNull()
    expect(d.mailing_card_parts).toBeNull()
  })

  it('no suite and no saved Principal Office: the saved office (CMRA) link is shown instead of an empty card', async () => {
    account.suite_number = null
    account.legal_address = null
    const d = await getPortalAccountDetail('a1')
    expect(d.legal_address).toBe('11125 Park Blvd, Suite 104-153, Seminole FL 33772')
  })

  it('a company with no suite yet keeps its saved Principal Office row', async () => {
    account.suite_number = null
    const d = await getPortalAccountDetail('a1')
    expect(d.legal_address).toBe('30 N Gould St, Ste R, Sheridan WY 82801')
    expect(d.legal_address_parts).toMatchObject({ address_line1: '30 N Gould St' })
  })
})
