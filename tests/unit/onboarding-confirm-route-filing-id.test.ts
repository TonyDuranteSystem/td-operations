/**
 * POST /api/onboarding-review/[id]/confirm — the State Filing ID staff checked on the review screen's card (job 64d2be64).
 * A plausible number is tidied and passed on; null ("no Filing ID on the document") is passed on as "save nothing"; a number that cannot be
 * an ID is refused before anything is confirmed; and a Confirm with no `filing_id` key keeps its exact old shape (3 arguments).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: vi.fn(async () => null) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: 'luca@tonydurante.us' } } }) } }),
}))
let source: string | null = 'portal_wizard'
let extraRow: Record<string, unknown> = {}
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { source, token: null, account_id: null, lead_id: null, offer_id: null, contact_id: null, upload_paths: [], ...extraRow }, error: null })
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

function req(body: unknown) {
  return new Request('http://localhost/api/onboarding-review/sub-1/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest
}

const okResult = { ok: true, alreadyApplied: false, lines: [], contact_id: 'c1', account_id: null, company_name: 'X LLC', pending: true }

beforeEach(() => {
  vi.clearAllMocks()
  source = 'portal_wizard'
  extraRow = {}
  confirmPortalWizardOnboarding.mockResolvedValue(okResult)
  applyOnboardingReview.mockResolvedValue(okResult)
})

describe('onboarding Confirm — the checked State Filing ID', () => {
  it('passes a checked number on, tidied', async () => {
    const res = await POST(req({ suite_choice: 'issue', filing_id: ' 2026 - 002103965 ' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(200)
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '2026-002103965', documentChecked: false })
  })

  it('passes null on as "this document has no Filing ID" (save nothing)', async () => {
    const res = await POST(req({ suite_choice: 'issue', filing_id: null }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(200)
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: null })
  })

  it('without a filing_id key the call keeps its exact old shape (nothing was checked)', async () => {
    await POST(req({ suite_choice: 'issue' }), { params: { id: 'sub-1' } })
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledTimes(1)
    expect(confirmPortalWizardOnboarding.mock.calls[0]).toHaveLength(3)
  })

  it('says the number was checked on a document only when the submission has Articles of its own to open', async () => {
    extraRow = { lead_id: 'lead-1', upload_paths: ['onboarding/lead-1/articles_of_organization_ab12_Articles.pdf'] }
    await POST(req({ suite_choice: 'issue', filing_id: '2026-002103965' }), { params: { id: 'sub-1' } })
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '2026-002103965', documentChecked: true })
  })

  it('Articles that belong to another folder do not count as a document that was opened', async () => {
    extraRow = { lead_id: 'lead-1', upload_paths: ['onboarding/someone-else/articles_of_organization_ab12_Articles.pdf', 'onboarding/lead-1/../../x/articles_of_organization_z.pdf'] }
    await POST(req({ suite_choice: 'issue', filing_id: '2026-002103965' }), { params: { id: 'sub-1' } })
    expect(confirmPortalWizardOnboarding).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '2026-002103965', documentChecked: false })
  })

  it('"none on the document" carries no document flag (nothing is saved either way)', async () => {
    await POST(req({ suite_choice: 'issue', filing_id: null }), { params: { id: 'sub-1' } })
    expect(confirmPortalWizardOnboarding.mock.calls[0][3]).toEqual({ value: null })
  })

  it('refuses a number that cannot be a Filing ID, in plain words, and confirms nothing', async () => {
    for (const bad of ['', 'n/a', 'abc', 'no number!', 12345678, { a: 1 }]) {
      const res = await POST(req({ suite_choice: 'issue', filing_id: bad }), { params: { id: 'sub-1' } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/State Filing ID can only contain letters, numbers and dashes/)
    }
    expect(confirmPortalWizardOnboarding).not.toHaveBeenCalled()
    expect(applyOnboardingReview).not.toHaveBeenCalled()
  })

  it('the manual token-link path gets the checked number too', async () => {
    source = null
    await POST(req({ suite_choice: 'issue', filing_id: '3190157' }), { params: { id: 'sub-1' } })
    expect(applyOnboardingReview).toHaveBeenCalledWith('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '3190157', documentChecked: false })
    expect(confirmPortalWizardOnboarding).not.toHaveBeenCalled()
  })

  it('the suite choice is still required first', async () => {
    const res = await POST(req({ filing_id: '3190157' }), { params: { id: 'sub-1' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/suite/i)
  })
})
