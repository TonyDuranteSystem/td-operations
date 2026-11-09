import { describe, it, expect, vi, beforeEach } from 'vitest'

const TOKEN = 'A'.repeat(43)

let tokenRow: Record<string, unknown> | null
let quoteRow: Record<string, unknown>
let lookupFails = false
const stripeCalls: Array<Record<string, unknown>> = []

// The route finds the invoice by its pay token with its OWN client…
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tokenRow, error: null }) }) }) }),
  }),
}))
// …and the shared quote reads the invoice + lines through supabaseAdmin.
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (lookupFails ? { data: null, error: { message: 'timeout' } } : { data: quoteRow, error: null }) }) }) }),
  },
}))
vi.mock('@/lib/config', () => ({ APP_BASE_URL: 'https://app.example' }))
vi.mock('@/lib/portal/resolve-payment-recipient', () => ({
  resolvePaymentRecipient: async () => ({ email: 'client@example.com', name: 'Client' }),
}))
vi.mock('@/lib/operations/autopay-claim', () => ({
  claimPaymentForCharge: async () => true,
  releasePaymentClaim: async () => {},
  recordCheckoutSessionId: async () => {},
  CLIENT_CLAIM_TTL_MS: 1,
}))
vi.mock('@/lib/payments/card-fee-config', () => ({ resolveChargeRate: async (pin: number | null) => pin ?? 0.05 }))
vi.mock('@/lib/stripe-checkout', () => ({
  createStripeCheckoutSession: async (p: Record<string, unknown>) => {
    stripeCalls.push(p)
    return { success: true, sessionId: 'cs_test_2', checkoutUrl: 'https://checkout.example/cs_test_2' }
  },
}))

import { GET } from '@/app/pay/[token]/route'

const call = () => GET({} as never, { params: { token: TOKEN } })

beforeEach(() => {
  stripeCalls.length = 0
  lookupFails = false
  tokenRow = { id: 'pid', account_id: 'acc', contact_id: null, amount: 1000, amount_currency: 'USD', status: 'Pending', description: 'x', invoice_number: 'INV-1', pay_token: TOKEN }
  quoteRow = { ...tokenRow, total: 1000, amount_paid: 500, card_fee_amount: null, invoice_status: 'Partial', card_fee_rate: 0.05 }
})

describe('GET /pay/[token] — the emailed pay link charges what is still owed + the card fee (same as the portal button)', () => {
  it('part-paid: $1,000 invoice, $500 paid → Stripe is asked for $525 = $500 + 5% (was: the whole $1,000, no fee)', async () => {
    const res = await call()
    expect(res.status).toBe(303)
    expect(stripeCalls[0].amount).toBe(525)
    expect(stripeCalls[0].currency).toBe('usd')
  })

  it('nothing paid: the whole invoice + 5%', async () => {
    quoteRow = { ...quoteRow, amount_paid: null, invoice_status: 'Sent' }
    await call()
    expect(stripeCalls[0].amount).toBe(1050)
  })

  it('a row Paid on its invoice status only goes to the thank-you page, not an error', async () => {
    quoteRow = { ...quoteRow, status: 'Pending', invoice_status: 'Paid' }
    const res = await call()
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/thanks')
    expect(stripeCalls).toHaveLength(0)
  })

  it('a database hiccup answers "try again" (503) instead of calling a valid link void', async () => {
    lookupFails = true
    const res = await call()
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/try again/i)
    expect(stripeCalls).toHaveLength(0)
  })

  it('Stripe is told it is the remaining balance + the card fee', async () => {
    await call()
    expect(stripeCalls[0].serviceName).toBe('x — remaining balance + 5% card fee')
  })

  it('a balance too small for a card gets a plain message pointing to bank transfer', async () => {
    quoteRow = { ...quoteRow, total: 100, amount: 100, amount_paid: 99.8 }
    const res = await call()
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/bank transfer/i)
    expect(stripeCalls).toHaveLength(0)
  })

  it('already Paid: sent to the thank-you page, no charge', async () => {
    tokenRow = { ...tokenRow!, status: 'Paid' }
    const res = await call()
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('/thanks')
    expect(stripeCalls).toHaveLength(0)
  })

  it('nothing owed: a plain message, no charge', async () => {
    quoteRow = { ...quoteRow, amount_paid: 1000 }
    const res = await call()
    expect(res.status).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })
})
