/**
 * POST /api/onboarding-review/[id]/confirm — the suite decision is REQUIRED (Antonio 2026-09-30): issue the company's suite,
 * or "No suite for this client" WITH a reason. A Confirm carrying neither is refused, and nothing is confirmed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: vi.fn(async () => null) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'luca@tonydurante.us' } } }) } }),
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { source: 'portal_wizard' }, error: null })
      return chain
    },
  },
}))
const confirmPortalWizardOnboarding = vi.fn()
const applyOnboardingReview = vi.fn()
vi.mock('@/lib/operations/onboarding-review', () => ({
  confirmPortalWizardOnboarding: (...a: unknown[]) => confirmPortalWizardOnboarding(...a),
  applyOnboardingReview: (...a: unknown[]) => applyOnboardingReview(...a),
}))

import { POST } from '@/app/api/onboarding-review/[id]/confirm/route'

function req(body?: unknown) {
  return new Request('http://localhost/api/onboarding-review/sub-1/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  confirmPortalWizardOnboarding.mockResolvedValue({ ok: true, alreadyApplied: false, lines: [], contact_id: 'c1', account_id: null, company_name: 'X LLC', pending: true })
})

describe('onboarding Confirm — the suite choice is required', () => {
  it('refuses a Confirm with no body at all, and confirms nothing', async () => {
    const res = await POST(req(), { params: { id: 'sub-1' } })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/suite/i)
    expect(confirmPortalWizardOnboarding).not.toHaveBeenCalled()
  })

  it('refuses "No suite for this client" without a reason', async () => {
    const res = await POST(req({ suite_choice: 'waive', suite_reason: '   ' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(400)
    expect(confirmPortalWizardOnboarding).not.toHaveBeenCalled()
  })

  it('refuses an unknown choice', async () => {
    const res = await POST(req({ suite_choice: 'maybe' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(400)
  })

  it('"Issue a suite" goes through to the confirm operation', async () => {
    const res = await POST(req({ suite_choice: 'issue' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(200)
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' })
  })

  it('"No suite for this client" with a reason goes through, trimmed', async () => {
    const res = await POST(req({ suite_choice: 'waive', suite_reason: '  one-time customer ' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(200)
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'waive', reason: 'one-time customer' })
  })
})
