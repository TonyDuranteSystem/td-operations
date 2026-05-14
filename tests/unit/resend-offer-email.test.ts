import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock surfaces ─────────────────────────────────────────
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

vi.mock('@/lib/config', () => ({
  APP_BASE_URL: 'https://app.tonydurante.us',
  PORTAL_BASE_URL: 'https://portal.tonydurante.us',
}))

vi.mock('@/lib/gmail', () => ({
  gmailPost: vi.fn(),
}))

vi.mock('@/lib/auth-admin-helpers', () => ({
  findAuthUserByEmail: vi.fn(),
}))

vi.mock('@/lib/portal/auto-create', () => ({
  autoCreatePortalUser: vi.fn(),
}))

vi.mock('@/lib/portal/welcome-token', () => ({
  createWelcomeToken: vi.fn(),
}))

vi.mock('@/lib/mcp/action-log', () => ({
  logAction: vi.fn(),
}))

vi.mock('@/lib/mcp/safe-send', () => ({
  safeSend: vi.fn(),
}))

import { resendOfferEmail } from '@/lib/offers/publish'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { autoCreatePortalUser } from '@/lib/portal/auto-create'
import { createWelcomeToken } from '@/lib/portal/welcome-token'
import { logAction } from '@/lib/mcp/action-log'

interface OfferRow {
  id: string
  token: string
  client_name: string
  client_email: string | null
  language: string | null
  status: string
  lead_id: string | null
  account_id: string | null
}

// Stub builder: supabaseAdmin.from('offers').select(...).eq(...).single() → offer row
// supabaseAdmin.from('email_tracking').insert(...) → { error: null }
function setSupabaseStubs(offer: OfferRow | null) {
  const offersChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: offer, error: offer ? null : { message: 'not found' } }),
  }
  const trackingChain = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
  }
  ;(supabaseAdmin.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'offers') return offersChain
    if (table === 'email_tracking') return trackingChain
    throw new Error(`Unexpected supabaseAdmin.from('${table}')`)
  })
  return { offersChain, trackingChain }
}

const baseOffer: OfferRow = {
  id: 'offer-id-1',
  token: 'tok-abc',
  client_name: 'Jane Doe',
  client_email: 'jane@example.com',
  language: 'en',
  status: 'sent',
  lead_id: null,
  account_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resendOfferEmail — existing portal user (dominant path)', () => {
  it('sends portal_notification email, does not create welcome token, logs resend', async () => {
    const stubs = setSupabaseStubs(baseOffer)
    ;(findAuthUserByEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'auth-1', email: baseOffer.client_email,
    })
    ;(gmailPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'gm-1', threadId: 't-1' })

    const result = await resendOfferEmail(baseOffer.token, 'unit-test')

    expect(result.success).toBe(true)
    expect(result.emailType).toBe('portal_notification')
    expect(result.welcomeUrl).toBeUndefined()
    expect(result.gmailMessageId).toBe('gm-1')

    // Gmail was called once
    expect(gmailPost).toHaveBeenCalledTimes(1)
    // No portal user creation
    expect(autoCreatePortalUser).not.toHaveBeenCalled()
    // No welcome token issued (existing user path)
    expect(createWelcomeToken).not.toHaveBeenCalled()
    // Tracking row inserted
    expect(stubs.trackingChain.insert).toHaveBeenCalledTimes(1)
    // Audit logged with action_type='resend'
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'resend',
        record_id: baseOffer.id,
        details: expect.objectContaining({
          email_type: 'portal_notification',
          gmail_message_id: 'gm-1',
          created_portal_user: false,
        }),
      })
    )
  })
})

describe('resendOfferEmail — defensive no-portal-user branch', () => {
  it('creates portal user, sends portal_access email, issues welcome token', async () => {
    setSupabaseStubs(baseOffer)
    ;(findAuthUserByEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(autoCreatePortalUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      alreadyExists: false,
      tempPassword: 'TempPass-9!',
      email: baseOffer.client_email,
    })
    ;(createWelcomeToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'welcome-tok-1',
      welcomeUrl: 'https://app.tonydurante.us/welcome/welcome-tok-1',
    })
    ;(gmailPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'gm-2', threadId: 't-2' })

    const result = await resendOfferEmail(baseOffer.token)

    expect(result.success).toBe(true)
    expect(result.emailType).toBe('portal_access')
    expect(result.welcomeUrl).toBe('https://app.tonydurante.us/welcome/welcome-tok-1')

    expect(autoCreatePortalUser).toHaveBeenCalledTimes(1)
    expect(createWelcomeToken).toHaveBeenCalledTimes(1)
    expect(createWelcomeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        email: baseOffer.client_email,
        tempPassword: 'TempPass-9!',
        source: 'offer',
        sourceId: baseOffer.token,
      })
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          created_portal_user: true,
          welcome_url: 'https://app.tonydurante.us/welcome/welcome-tok-1',
        }),
      })
    )
  })

  it('does not block the send if createWelcomeToken throws', async () => {
    setSupabaseStubs(baseOffer)
    ;(findAuthUserByEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(autoCreatePortalUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, alreadyExists: false, tempPassword: 'pw',
    })
    ;(createWelcomeToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'))
    ;(gmailPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'gm-3', threadId: 't-3' })

    const result = await resendOfferEmail(baseOffer.token)

    expect(result.success).toBe(true)
    expect(result.welcomeUrl).toBeUndefined()
    expect(gmailPost).toHaveBeenCalledTimes(1)
  })
})

describe('resendOfferEmail — rejection paths', () => {
  it('rejects draft offers', async () => {
    setSupabaseStubs({ ...baseOffer, status: 'draft' })
    const result = await resendOfferEmail(baseOffer.token)
    expect(result.success).toBe(false)
    expect(result.error).toContain("'draft'")
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('rejects unknown tokens', async () => {
    setSupabaseStubs(null)
    const result = await resendOfferEmail('does-not-exist')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Offer not found')
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('rejects offers with no client_email', async () => {
    setSupabaseStubs({ ...baseOffer, client_email: null })
    const result = await resendOfferEmail(baseOffer.token)
    expect(result.success).toBe(false)
    expect(result.error).toContain('client_email')
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('surfaces gmail failures and skips tracking + audit', async () => {
    const stubs = setSupabaseStubs(baseOffer)
    ;(findAuthUserByEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'auth-1', email: baseOffer.client_email })
    ;(gmailPost as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SMTP down'))

    const result = await resendOfferEmail(baseOffer.token)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Gmail send failed')
    expect(stubs.trackingChain.insert).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
})

describe('resendOfferEmail — status independence', () => {
  for (const status of ['sent', 'viewed', 'signed', 'completed', 'expired']) {
    it(`works on '${status}' offers`, async () => {
      setSupabaseStubs({ ...baseOffer, status })
      ;(findAuthUserByEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'auth-1', email: baseOffer.client_email })
      ;(gmailPost as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: `gm-${status}`, threadId: 't' })

      const result = await resendOfferEmail(baseOffer.token)
      expect(result.success).toBe(true)
      expect(result.emailType).toBe('portal_notification')
    })
  }
})
