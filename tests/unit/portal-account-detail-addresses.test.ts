import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The client sees THREE addresses (Antonio 2026-10-01): Principal Office, Mailing Address (Seminole), Registered Agent.
 * The Principal Office is ALWAYS our Largo office + the company's own suite whatever address row is saved; a company with
 * no suite yet keeps its saved row. There is no CMRA card.
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
  it('shows Largo + the company\'s own suite, even when the saved address is somewhere else', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.legal_address).toBe('10225 Ulmerton Rd, Suite 3D-212, Largo FL 33771')
    expect(d.legal_address_parts).toMatchObject({ address_line1: '10225 Ulmerton Rd', address_line2: 'Suite 3D-212', city: 'Largo', state: 'FL', zip: '33771' })
  })

  it('a wrongly linked Seminole mailing row no longer reaches any client card or the document address', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.physical_address).toBe('10225 Ulmerton Rd, Suite 3D-212, Largo FL 33771')
  })

  it('the Mailing Address (Seminole) card is untouched', async () => {
    const d = await getPortalAccountDetail('a1')
    expect(d.shipping_address).toBe('11125 Park Blvd, Suite 104-153, Seminole FL 33772')
  })

  it('a company with no suite yet keeps its saved Principal Office row', async () => {
    account.suite_number = null
    const d = await getPortalAccountDetail('a1')
    expect(d.legal_address).toBe('30 N Gould St, Ste R, Sheridan WY 82801')
    expect(d.legal_address_parts).toMatchObject({ address_line1: '30 N Gould St' })
  })
})
