import { describe, it, expect, vi, beforeEach } from 'vitest'

const PAYMENT_ID = '2f5d6a59-4910-4256-b2da-0d3f5fe9a90c'

let row: Record<string, unknown>
let dbShouldThrow = false
let dbReturnsError = false
let selectedColumns = ''
const stripeCalls: Array<Record<string, unknown>> = []
let claims = 0

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: (cols: string) => {
        selectedColumns = cols
        return {
          eq: () => ({
            maybeSingle: async () => {
              if (dbShouldThrow) throw new Error('relation "payments" does not exist (secret db text)')
              if (dbReturnsError) return { data: null, error: { message: 'timeout' } }
              return { data: row, error: null }
            },
          }),
        }
      },
    }),
  },
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/portal/resolve-payment-recipient', () => ({
  resolvePaymentRecipient: async () => ({ email: 'client@example.com', name: 'Client' }),
}))
vi.mock('@/lib/operations/autopay-claim', () => ({
  claimPaymentForCharge: async () => { claims += 1; return true },
  releasePaymentClaim: async () => {},
  recordCheckoutSessionId: async () => {},
  CLIENT_CLAIM_TTL_MS: 1,
}))
// The fee rate/switch lookup is its own tested unit; here it just returns the pin.
vi.mock('@/lib/payments/card-fee-config', () => ({
  resolveChargeRate: async (pin: number | null) => pin ?? 0.05,
}))
vi.mock('@/lib/stripe-checkout', () => ({
  createStripeCheckoutSession: async (p: Record<string, unknown>) => {
    stripeCalls.push(p)
    return { success: true, sessionId: 'cs_test_1', checkoutUrl: 'https://checkout.example/cs_test_1' }
  },
}))

import { GET, POST } from '@/app/api/workflows/create-invoice-checkout/route'

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID, account_id: 'acc', contact_id: null, description: 'Annual renewal', invoice_number: 'INV-QA-1',
    amount: 150, total: 150, amount_paid: 100, card_fee_amount: null, amount_currency: 'USD', status: 'Pending', invoice_status: 'Partial',
    card_fee_rate: 0.05, ...over,
  }
}
const post = (body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }) as never)
const get = (qs: string) =>
  GET({ nextUrl: new URL(`http://x/api/workflows/create-invoice-checkout${qs}`) } as never)

beforeEach(() => {
  stripeCalls.length = 0
  claims = 0
  dbShouldThrow = false
  dbReturnsError = false
  selectedColumns = ''
  row = invoice()
})

describe('POST create-invoice-checkout — charges what is still owed', () => {
  it('a discounted invoice is charged on the total the client was told: $900 + 5% = $945, not $1,050', async () => {
    row = invoice({ amount: 900, total: 900, amount_paid: null, invoice_status: 'Sent' })
    const res = await post({ payment_id: PAYMENT_ID })
    expect(res.status).toBe(200)
    expect(stripeCalls[0].amount).toBe(945)
  })

  it('part-paid ($150 invoice, $100 paid): Stripe is asked for $52.50, not $157.50', async () => {
    const res = await post({ payment_id: PAYMENT_ID })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(stripeCalls).toHaveLength(1)
    expect(stripeCalls[0].amount).toBe(52.5)
    expect(body).toMatchObject({ amount: 50, alreadyPaid: 100, invoiceTotal: 150, fee: 2.5, cardAmount: 52.5, currency: 'usd' })
  })

  it('ordinary invoice, nothing paid: unchanged — whole invoice + 5%', async () => {
    row = invoice({ amount_paid: null, invoice_status: 'Sent' })
    const res = await post({ payment_id: PAYMENT_ID })
    expect(res.status).toBe(200)
    expect(stripeCalls[0].amount).toBe(157.5)
    expect((await res.json()).amount).toBe(150)
  })

  it('refuses a Paid invoice: nothing claimed, Stripe never called', async () => {
    row = invoice({ status: 'Paid', invoice_status: 'Paid' })
    const res = await post({ payment_id: PAYMENT_ID })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Payment already paid')
    expect(claims).toBe(0)
    expect(stripeCalls).toHaveLength(0)
  })

  it('refuses a voided invoice', async () => {
    row = invoice({ invoice_status: 'Voided' })
    const res = await post({ payment_id: PAYMENT_ID })
    expect(res.status).toBe(400)
    expect(stripeCalls).toHaveLength(0)
  })

  it('404 when the invoice does not exist', async () => {
    row = undefined as never
    const res = await post({ payment_id: PAYMENT_ID })
    expect(res.status).toBe(404)
  })

  it('rejects a bad payment_id', async () => {
    expect((await post({ payment_id: 'nope' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
  })
})

describe('the invoice lookup', () => {
  it('reads every column the price depends on (a dropped column would silently change the price)', async () => {
    await get(`?payment_id=${PAYMENT_ID}`)
    for (const col of ['total', 'amount', 'amount_paid', 'card_fee_amount', 'card_fee_rate', 'status', 'invoice_status', 'amount_currency']) {
      expect(selectedColumns).toContain(col)
    }
  })

  it('a failed lookup is a retry-later (503) on both GET and POST — never "not found"', async () => {
    dbReturnsError = true
    const g = await get(`?payment_id=${PAYMENT_ID}`)
    expect(g.status).toBe(503)
    expect(await g.json()).toMatchObject({ reason: 'unavailable' })
    const p = await post({ payment_id: PAYMENT_ID })
    expect(p.status).toBe(503)
    expect(stripeCalls).toHaveLength(0)
  })

  it('Stripe is told in one line that it is the remaining balance and includes the card fee', async () => {
    await post({ payment_id: PAYMENT_ID })
    expect(stripeCalls[0].serviceName).toBe('Annual renewal — remaining balance + 5% card fee')
  })
})

describe('GET create-invoice-checkout — the price the popup shows', () => {
  it('returns the same numbers POST would charge, and starts no payment', async () => {
    const res = await get(`?payment_id=${PAYMENT_ID}`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ amount: 50, fee: 2.5, cardFeeRate: 0.05, cardAmount: 52.5, alreadyPaid: 100 })
    expect(stripeCalls).toHaveLength(0)
    expect(claims).toBe(0)
  })

  it('tells the popup why a card payment is not possible', async () => {
    row = invoice({ amount_paid: 150 })
    const res = await get(`?payment_id=${PAYMENT_ID}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'nothing_owed' })
  })

  it('rejects a bad payment_id', async () => {
    expect((await get('?payment_id=nope')).status).toBe(400)
    expect((await get('')).status).toBe(400)
  })

  it('a database failure answers a plain sentence, never the raw database text', async () => {
    dbShouldThrow = true
    const res = await get(`?payment_id=${PAYMENT_ID}`)
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.error).not.toContain('secret db text')
    expect(body.error).toMatch(/try again/i)
    expect(body.reason).toBe('unavailable') // lets the popup show its translated 'could not load the price' text
  })

  it('a too-small balance is refused with its own reason', async () => {
    row = invoice({ amount: 100, total: 100, amount_paid: 99.8, amount_currency: 'EUR' })
    const res = await get(`?payment_id=${PAYMENT_ID}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'too_small' })
  })

  it('a discounted invoice (lines would say $1,000, total $900) is priced on the $900', async () => {
    row = invoice({ amount: 900, total: 900, amount_paid: null, invoice_status: 'Sent' })
    const body = await (await get(`?payment_id=${PAYMENT_ID}`)).json()
    expect(body).toMatchObject({ amount: 900, cardAmount: 945 })
  })
})
