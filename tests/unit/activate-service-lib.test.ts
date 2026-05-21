import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase-admin before importing the module
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(),
    auth: {
      admin: {
        updateUserById: vi.fn(),
      },
    },
  },
}))

// Mock all other dependencies
vi.mock('@/lib/db', () => ({ dbWrite: vi.fn(), dbWriteSafe: vi.fn((p) => p) }))
vi.mock('@/lib/operations/service-delivery', () => ({ createSD: vi.fn() }))
vi.mock('@/lib/auth-admin-helpers', () => ({ findAuthUserByEmail: vi.fn() }))
vi.mock('@/lib/portal/auto-create', () => ({
  ensureMinimalAccount: vi.fn(),
  autoCreatePortalUser: vi.fn(),
  sendPortalWelcomeEmail: vi.fn(),
  tierForContract: vi.fn(() => 'active'),
}))
vi.mock('@/lib/portal/td-invoice', () => ({ createTDInvoice: vi.fn() }))
vi.mock('@/lib/portal/unified-invoice', () => ({ syncInvoiceStatus: vi.fn() }))
vi.mock('@/lib/portal/notifications', () => ({ createPortalNotification: vi.fn() }))
vi.mock('@/lib/portal/welcome-message', () => ({
  getWelcomeMessage: vi.fn().mockResolvedValue(null),
  renderTemplate: vi.fn((t: string) => t),
}))
vi.mock('@/lib/referral-utils', () => ({ calculateCommission: vi.fn() }))
vi.mock('@/lib/tax-return-context', () => ({ findTaxReturnService: vi.fn() }))
vi.mock('@/lib/settings', () => ({ isTaxSeasonPaused: vi.fn(() => false) }))
vi.mock('@/lib/portal/entity-type-from-contract', () => ({ getEntityTypeFromContract: vi.fn() }))
vi.mock('@/lib/portal/tier-config', () => ({
  TIER_ORDER: { lead: 0, formation: 1, onboarding: 2, active: 3 },
}))
vi.mock('@/lib/gmail', () => ({ gmailPost: vi.fn() }))

import { runActivation } from '@/lib/operations/activate-service'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { autoCreatePortalUser } from '@/lib/portal/auto-create'

// Returns a fully chainable Supabase query mock.
// All builder methods return the same chain. Direct await resolves to { data, error: null }.
function makeChain(data: unknown) {
  const p = Promise.resolve({ data, error: null })
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    ilike: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    not: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    order: vi.fn(() => chain),
    update: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve({ data, error: null })),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    finally: p.finally.bind(p),
  }
  return chain
}

// Minimal fixtures for a formation activation with a linked lead + contact.
const activationFixture = {
  id: 'pa-id', status: 'payment_confirmed', offer_token: 'tok',
  lead_id: 'lead-id', client_name: 'Test', client_email: 'test@x.com',
  amount: 0, currency: 'EUR', payment_method: 'wire', portal_invoice_id: null,
}
const offerFixture = {
  contract_type: 'formation', bundled_pipelines: [], account_id: null,
  selected_services: [], services: [], client_name: 'Test', cost_summary: [],
  referrer_name: null, referrer_type: null, referrer_email: null,
  referrer_commission_type: null, referrer_commission_pct: null,
  referrer_agreed_price: null, referrer_account_id: null,
  partner_id: null, partner_payout_model: null,
  partner_payout_rate: null, partner_invoice_target: null,
}
const contactFixture = {
  id: 'contact-id', email: 'test@x.com', portal_tier: 'lead',
  language: 'English', first_name: 'Test', last_name: null, full_name: 'Test',
}
const leadFixture = {
  id: 'lead-id', converted_to_contact_id: 'contact-id',
  full_name: 'Test', email: 'test@x.com', language: 'English', status: 'Offer Sent',
}

describe('runActivation', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('returns ok:true immediately when activation is already activated', async () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'test-id', status: 'activated', offer_token: 'tok', client_email: 'x@x.com' },
            error: null,
          }),
        }),
      }),
    })
    vi.mocked(supabaseAdmin.from).mockImplementation(mockFrom)

    const result = await runActivation('test-id')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Already activated')
  })

  it('returns error with status 404 when activation not found', async () => {
    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
        }),
      }),
    })
    vi.mocked(supabaseAdmin.from).mockImplementation(mockFrom)

    const result = await runActivation('nonexistent-id')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it('flips lead to Converted and includes lead_converted step', async () => {
    const leadsUpdateArgs: Array<Record<string, unknown>> = []

    // Leads chain: single() returns lead data; update() captures args and returns 1 row (flipped)
    const leadsChain = makeChain(leadFixture)
    leadsChain.update = vi.fn((args: Record<string, unknown>) => {
      leadsUpdateArgs.push(args)
      return makeChain([{ id: 'lead-id' }])
    })

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'pending_activations') return makeChain(activationFixture) as ReturnType<typeof supabaseAdmin.from>
      if (table === 'offers') return makeChain(offerFixture) as ReturnType<typeof supabaseAdmin.from>
      if (table === 'leads') return leadsChain as ReturnType<typeof supabaseAdmin.from>
      if (table === 'contacts') return makeChain(contactFixture) as ReturnType<typeof supabaseAdmin.from>
      return makeChain(null) as ReturnType<typeof supabaseAdmin.from>
    })

    vi.mocked(autoCreatePortalUser).mockResolvedValue(
      { success: false, alreadyExists: true, email: 'test@x.com' } as Awaited<ReturnType<typeof autoCreatePortalUser>>
    )

    const result = await runActivation('pa-id')

    expect(result.ok).toBe(true)
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'lead_converted', status: 'done', detail: expect.stringContaining('→ Converted') }),
    ]))
    expect(leadsUpdateArgs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'Converted' }),
    ]))
  })

  it('reports already Converted when lead is already at that status', async () => {
    // update() returns 0 rows — the .neq("status","Converted") guard matched nothing
    const leadsChain = makeChain(leadFixture)
    leadsChain.update = vi.fn(() => makeChain([]))

    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'pending_activations') return makeChain(activationFixture) as ReturnType<typeof supabaseAdmin.from>
      if (table === 'offers') return makeChain(offerFixture) as ReturnType<typeof supabaseAdmin.from>
      if (table === 'leads') return leadsChain as ReturnType<typeof supabaseAdmin.from>
      if (table === 'contacts') return makeChain(contactFixture) as ReturnType<typeof supabaseAdmin.from>
      return makeChain(null) as ReturnType<typeof supabaseAdmin.from>
    })

    vi.mocked(autoCreatePortalUser).mockResolvedValue(
      { success: false, alreadyExists: true, email: 'test@x.com' } as Awaited<ReturnType<typeof autoCreatePortalUser>>
    )

    const result = await runActivation('pa-id')

    expect(result.ok).toBe(true)
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'lead_converted', status: 'done', detail: expect.stringContaining('already Converted') }),
    ]))
  })
})
