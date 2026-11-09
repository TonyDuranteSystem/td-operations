import { describe, it, expect, vi, beforeEach } from 'vitest'

// A tiny in-memory stand-in for the two tables bookCardFee touches.
let invoiceRow: Record<string, unknown>
let itemRows: Array<Record<string, unknown>>
let paymentUpdates: Array<Record<string, unknown>>
let insertedItems: Array<Record<string, unknown>>
let paymentSelect = ''

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'payments') {
        return {
          select: (cols: string) => { paymentSelect = cols; return { eq: () => ({ single: async () => ({ data: invoiceRow, error: null }) }) } },
          update: (patch: Record<string, unknown>) => ({
            eq: async () => { paymentUpdates.push(patch); return { error: null } },
          }),
        }
      }
      // payment_items
      return {
        select: () => ({
          eq: (col: string) => {
            // load items: .eq('payment_id') resolves directly; fee lookup chains .eq('item_type').maybeSingle()
            const base = Promise.resolve({ data: itemRows, error: null }) as Promise<unknown> & {
              eq?: (c: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> }
            }
            base.eq = () => ({ maybeSingle: async () => ({ data: itemRows.find(r => r.item_type === 'fee') ?? null }) })
            void col
            return base
          },
        }),
        insert: async (row: Record<string, unknown>) => { insertedItems.push(row); return { error: null } },
        update: () => ({ eq: async () => ({ error: null }) }),
      }
    },
  },
}))

import { bookCardFee } from '@/lib/finance/card-fee-booking'

beforeEach(() => {
  paymentUpdates = []
  insertedItems = []
})

describe('bookCardFee — fee base is what was STILL OWED', () => {
  it('reads every column the base depends on (a dropped column would silently change the fee)', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: null, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ id: 'svc1', amount: 1000, item_type: 'service' }]
    await bookCardFee('inv', 1050)
    for (const col of ['total', 'amount', 'amount_paid', 'card_fee_amount', 'card_fee_rate']) {
      expect(paymentSelect).toContain(col)
    }
  })

  it('part-paid: $1,000 invoice, $500 already paid, card charged $525 → books $25 and settles to a $1,025 total', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 500, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]

    const r = await bookCardFee('inv', 525)

    expect(r.outcome).toBe('booked')
    expect(r.base).toBe(500) // the balance, not the whole invoice
    expect(r.fee).toBe(25)
    expect(insertedItems[0]).toMatchObject({ item_type: 'fee', amount: 25 })
    // invoice total = whole invoice + the fee; 500 (earlier) + 525 (card) = 1025 → settles fully
    expect(paymentUpdates[0]).toMatchObject({ total: 1025, amount: 1025, card_fee_amount: 25 })
  })

  it('nothing paid before: identical to the old behaviour ($1,000 charged $1,050 → fee $50, total $1,050)', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: null, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]

    const r = await bookCardFee('inv', 1050)

    expect(r.outcome).toBe('booked')
    expect(r.base).toBe(1000)
    expect(r.fee).toBe(50)
    expect(paymentUpdates[0]).toMatchObject({ total: 1050, amount: 1050, card_fee_amount: 50 })
  })

  it('amount_paid of 0 behaves like nothing paid', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 0, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]
    const r = await bookCardFee('inv', 1050)
    expect(r.outcome).toBe('booked')
    expect(r.base).toBe(1000)
  })

  it('STALE PAGE: a wire paid part AFTER the card page opened, so the card is charged the old full price → overage (flagged), no fee booked', async () => {
    // page opened at $1,000 + 5% = $1,050; then $500 arrived by wire; client pays $1,050 anyway
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 500, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]

    const r = await bookCardFee('inv', 1050)

    expect(r.outcome).toBe('overage')
    expect(r.base).toBe(500)
    expect(insertedItems).toHaveLength(0)
    expect(paymentUpdates).toHaveLength(0)
  })

  it('fee switch off: charged exactly the balance → no fee line', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 500, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]
    const r = await bookCardFee('inv', 500)
    expect(r.outcome).toBe('no_fee')
    expect(insertedItems).toHaveLength(0)
  })

  it('a card payment on an invoice with nothing left owed is flagged, not silently booked', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 1000, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]
    const r = await bookCardFee('inv', 525)
    expect(r.outcome).toBe('overage')
    expect(paymentUpdates).toHaveLength(0)
  })

  it('DISCOUNTED invoice (lines $1,000, total $900): the fee is booked on the $900 owed — the discount is NOT erased', async () => {
    invoiceRow = { id: 'inv', total: 900, amount: 900, amount_paid: null, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 1000, item_type: 'service' }]
    const r = await bookCardFee('inv', 945)
    expect(r.outcome).toBe('booked')
    expect(r.base).toBe(900)
    expect(r.fee).toBe(45)
    expect(paymentUpdates[0]).toMatchObject({ total: 945, amount: 945, card_fee_amount: 45 })
  })

  it('PAYMENT-PLAN part (lines $2,500, total $1,250): booked on the $1,250, no false overage', async () => {
    invoiceRow = { id: 'inv', total: 1250, amount: 1250, amount_paid: null, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ amount: 2500, item_type: 'service' }]
    const r = await bookCardFee('inv', 1312.5)
    expect(r.outcome).toBe('booked')
    expect(r.fee).toBe(62.5)
    expect(paymentUpdates[0]).toMatchObject({ total: 1312.5 })
  })

  it('RETRY after the fee was booked but BEFORE the settle landed: same fee, same total (idempotent)', async () => {
    // first run left: total bumped to 1025, card_fee_amount 25, a fee line; amount_paid still 500
    invoiceRow = { id: 'inv', total: 1025, amount: 1025, amount_paid: 500, card_fee_amount: 25, card_fee_rate: 0.05 }
    itemRows = [{ id: 'svc1', amount: 1000, item_type: 'service' }, { id: 'fee1', amount: 25, item_type: 'fee' }]
    const r = await bookCardFee('inv', 525)
    expect(r.outcome).toBe('booked')
    expect(r.base).toBe(500)
    expect(r.fee).toBe(25)
    expect(paymentUpdates[0]).toMatchObject({ total: 1025, amount: 1025, card_fee_amount: 25 })
    expect(insertedItems).toHaveLength(0) // the existing fee line is updated, never doubled
  })

  it('RETRY after a crash between the fee line and the total bump: total still unbumped → same result', async () => {
    invoiceRow = { id: 'inv', total: 1000, amount: 1000, amount_paid: 500, card_fee_amount: null, card_fee_rate: 0.05 }
    itemRows = [{ id: 'svc1', amount: 1000, item_type: 'service' }, { id: 'fee1', amount: 25, item_type: 'fee' }]
    const r = await bookCardFee('inv', 525)
    expect(r.outcome).toBe('booked')
    expect(paymentUpdates[0]).toMatchObject({ total: 1025, card_fee_amount: 25 })
  })
})
