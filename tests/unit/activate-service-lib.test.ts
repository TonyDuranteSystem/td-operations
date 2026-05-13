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
vi.mock('@/lib/referral-utils', () => ({ calculateCommission: vi.fn() }))
vi.mock('@/lib/tax-return-context', () => ({ findTaxReturnService: vi.fn() }))
vi.mock('@/lib/settings', () => ({ isTaxSeasonPaused: vi.fn(() => false) }))
vi.mock('@/lib/portal/entity-type-from-contract', () => ({ getEntityTypeFromContract: vi.fn() }))
vi.mock('@/lib/portal/tier-config', () => ({
  TIER_ORDER: { lead: 0, formation: 1, onboarding: 2, active: 3 },
}))

import { runActivation } from '@/lib/operations/activate-service'
import { supabaseAdmin } from '@/lib/supabase-admin'

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
})
