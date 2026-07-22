import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin before importing the module under test
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

import { getAccountActivity, getContactActivity } from '@/lib/operations/account-activity'
import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockChain(data: unknown[]) {
  // Supabase builders are both chainable AND thenable (Promise-like).
  // Every method must return the same chain so chaining works, and the
  // chain itself must be awaitable (have .then()) so any terminal call works.
  const resolved = { data, error: null }
  const chain: Record<string, unknown> = {
    then: (resolve: (v: typeof resolved) => unknown) => Promise.resolve(resolved).then(resolve),
    catch: (reject: (e: unknown) => unknown) => Promise.resolve(resolved).catch(reject),
  }
  const methods = ['select', 'eq', 'or', 'neq', 'not', 'is', 'in', 'order', 'limit', 'maybeSingle']
  methods.forEach((m) => {
    chain[m] = vi.fn(() => chain)
  })
  return chain
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('getAccountActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when all tables return no rows', async () => {
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockReturnValue(emptyChain as never)

    const result = await getAccountActivity('acct-123')
    expect(result).toEqual([])
  })

  it('maps an offer row to offer-created event', async () => {
    const offerChain = mockChain([
      {
        id: 'off-1',
        token: 'tok-1',
        status: 'sent',
        contract_type: 'formation',
        client_name: 'Test Client',
        created_at: '2026-05-01T10:00:00.000Z',
        viewed_at: null,
        updated_at: '2026-05-01T10:00:00.000Z',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'offers') return offerChain as never
      return emptyChain as never
    })

    const result = await getAccountActivity('acct-123')
    const offerEvent = result.find((e) => e.id === 'offer-created-off-1')
    expect(offerEvent).toBeDefined()
    expect(offerEvent?.type).toBe('offer')
    expect(offerEvent?.title).toBe('Offer created — LLC Formation')
    expect(offerEvent?.body).toBe('Test Client')
    expect(offerEvent?.timestamp).toBe('2026-05-01T10:00:00.000Z')
  })

  it('emits offer-viewed event when viewed_at is set', async () => {
    const offerChain = mockChain([
      {
        id: 'off-2',
        token: 'tok-2',
        status: 'viewed',
        contract_type: null,
        client_name: null,
        created_at: '2026-05-01T10:00:00.000Z',
        viewed_at: '2026-05-02T14:00:00.000Z',
        updated_at: '2026-05-02T14:00:00.000Z',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'offers' ? (offerChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const viewEvent = result.find((e) => e.id === 'offer-viewed-off-2')
    expect(viewEvent).toBeDefined()
    expect(viewEvent?.timestamp).toBe('2026-05-02T14:00:00.000Z')
  })

  it('emits activation events when offer is signed', async () => {
    const offerChain = mockChain([
      {
        id: 'off-3',
        token: 'tok-3',
        status: 'signed',
        contract_type: 'onboarding',
        client_name: null,
        created_at: '2026-05-01T10:00:00.000Z',
        viewed_at: null,
        updated_at: '2026-05-03T09:00:00.000Z',
      },
    ])
    const paChain = mockChain([
      {
        offer_token: 'tok-3',
        signed_at: '2026-05-03T09:00:00.000Z',
        payment_confirmed_at: '2026-05-04T11:00:00.000Z',
        activated_at: '2026-05-04T11:05:00.000Z',
        payment_method: 'wire',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) => {
      if (table === 'offers') return offerChain as never
      if (table === 'pending_activations') return paChain as never
      return emptyChain as never
    })

    const result = await getAccountActivity('acct-123')
    expect(result.find((e) => e.id === 'offer-signed-off-3')).toBeDefined()
    expect(result.find((e) => e.id === 'pa-paid-tok-3')).toBeDefined()
    expect(result.find((e) => e.id === 'pa-activated-tok-3')).toBeDefined()
  })

  it('expands stage_history new format into service events', async () => {
    const sdChain = mockChain([
      {
        id: 'sd-1',
        service_name: 'ITIN',
        service_type: 'ITIN',
        status: 'active',
        created_at: '2026-04-01T08:00:00.000Z',
        stage_history: [
          {
            to_stage: 'Document Collection',
            from_stage: 'Intake',
            advanced_at: '2026-04-10T10:00:00.000Z',
            to_order: 2,
            from_order: 1,
            notes: null,
            advanced_by: 'crm-admin',
          },
        ],
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'service_deliveries' ? (sdChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const stageEvent = result.find((e) => e.id.startsWith('sd-stage-ITIN-Document Collection'))
    expect(stageEvent).toBeDefined()
    expect(stageEvent?.title).toBe('ITIN → Document Collection')
    expect(stageEvent?.body).toBe('from Intake')
    expect(stageEvent?.timestamp).toBe('2026-04-10T10:00:00.000Z')
  })

  it('expands stage_history old format (at/event/note) into service events', async () => {
    const sdChain = mockChain([
      {
        id: 'sd-2',
        service_name: 'CMRA',
        service_type: 'CMRA',
        status: 'active',
        created_at: '2026-03-01T08:00:00.000Z',
        stage_history: [
          {
            at: '2026-03-15T12:00:00.000Z',
            event: 'lease_signed',
            note: 'Suite 3D-112',
          },
        ],
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'service_deliveries' ? (sdChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const oldEvent = result.find((e) => e.id.startsWith('sd-event-CMRA'))
    expect(oldEvent).toBeDefined()
    expect(oldEvent?.title).toBe('CMRA — lease signed')
    expect(oldEvent?.body).toBe('Suite 3D-112')
    expect(oldEvent?.timestamp).toBe('2026-03-15T12:00:00.000Z')
  })

  it('converts DATE-only paid_date to a sortable ISO timestamp', async () => {
    const pmtChain = mockChain([
      {
        id: 'pmt-1',
        description: 'Setup fee',
        amount: 2000,
        amount_currency: 'USD',
        invoice_number: 'INV-001234',
        created_at: '2026-04-01T08:00:00.000Z',
        sent_at: null,
        paid_date: '2026-04-15',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'payments' ? (pmtChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const paidEvent = result.find((e) => e.id === 'payment-paid-pmt-1')
    expect(paidEvent).toBeDefined()
    expect(paidEvent?.timestamp).toBe('2026-04-15T12:00:00.000Z')
  })

  it('returns events sorted newest-first', async () => {
    const offerChain = mockChain([
      {
        id: 'off-a',
        token: 'tok-a',
        status: 'sent',
        contract_type: null,
        client_name: null,
        created_at: '2026-03-01T00:00:00.000Z',
        viewed_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'offers' ? (offerChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const timestamps = result.map((e) => e.timestamp)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1] >= timestamps[i]).toBe(true)
    }
  })

  it('deduplicates events with the same id', async () => {
    // wizard with same created_at and updated_at → only "started", no "submitted"
    const wizardChain = mockChain([
      {
        id: 'wiz-1',
        wizard_type: 'formation',
        status: 'in_progress',
        created_at: '2026-05-01T08:00:00.000Z',
        updated_at: '2026-05-01T08:00:00.000Z',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'wizard_progress' ? (wizardChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123')
    const wizardEvents = result.filter((e) => e.source === 'wizard_progress')
    // only "started" — status is in_progress, not submitted
    expect(wizardEvents).toHaveLength(1)
    // This assertion used to read 'Wizard started — formation' — it was pinning
    // the RAW wizard_type. That feed is client-visible (portal chat "Log" tab),
    // so the raw code was reaching clients; see lib/portal/wizard-labels.ts.
    expect(wizardEvents[0].title).toBe('Wizard started — LLC Formation')
  })

  it('respects limit option', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `off-${i}`,
      token: `tok-${i}`,
      status: 'sent',
      contract_type: null,
      client_name: null,
      created_at: new Date(2026, 0, i + 1).toISOString(),
      viewed_at: null,
      updated_at: new Date(2026, 0, i + 1).toISOString(),
    }))
    const offerChain = mockChain(many)
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'offers' ? (offerChain as never) : (emptyChain as never),
    )

    const result = await getAccountActivity('acct-123', { limit: 5 })
    expect(result.length).toBeLessThanOrEqual(5)
  })
})

describe('getContactActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array when all tables return no rows', async () => {
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockReturnValue(emptyChain as never)

    const result = await getContactActivity('contact-123')
    expect(result).toEqual([])
  })

  it('uses contact_id filter for portal_messages', async () => {
    const msgChain = mockChain([
      {
        id: 'msg-1',
        message: 'Hello',
        created_at: '2026-05-01T10:00:00.000Z',
      },
    ])
    const emptyChain = mockChain([])
    vi.mocked(supabaseAdmin.from).mockImplementation((table: string) =>
      table === 'portal_messages' ? (msgChain as never) : (emptyChain as never),
    )

    const result = await getContactActivity('contact-123')
    const msgEvent = result.find((e) => e.id === 'msg-msg-1')
    expect(msgEvent).toBeDefined()
    expect(msgEvent?.type).toBe('message')
    expect(msgEvent?.body).toBe('Hello')
  })
})
