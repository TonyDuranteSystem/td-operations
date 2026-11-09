/**
 * Card quote — what a client is asked to pay BY CARD for a Tony Durante invoice,
 * worked out in ONE place from the invoice's LIVE state.
 *
 * Before this, three places each decided the card price on their own: the portal Pay
 * popup (a private "+5%, rounded up"), the card checkout route and the emailed pay
 * link (both read the WHOLE invoice amount). A client who had already wired part of an
 * invoice saw the balance in the popup but was charged the whole invoice plus the fee.
 *
 * The rule, with nothing hardcoded:
 *   still owed  = the invoice's total without any card fee (`invoiceBaseExFee`) − what
 *                 was already paid
 *   card price  = still owed × (1 + the rate PINNED on the invoice; 0 when the global
 *                 fee switch is off)
 * The TOTAL is the base — the figure the client was told — never the line items (a
 * discount, a tax line or a payment-plan part makes the lines differ from the total).
 * Nothing paid yet → still owed is the whole total, so an ordinary card payment is
 * exactly what it was. The fee booking (lib/finance/card-fee-booking.ts) starts from the
 * same "still owed" number, so what we ask Stripe for and what we expect to have been
 * charged can never drift apart.
 *
 * `buildCardQuote` is pure (unit-tested without a database); `getCardQuote` loads the
 * invoice and resolves the rate.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { balanceOwed, computeCardTotal, invoiceBaseExFee, MIN_CARD_CHARGE, round2 } from '@/lib/payments/card-fee'
import { resolveChargeRate } from '@/lib/payments/card-fee-config'
import { isTerminalInvoice } from '@/lib/finance/invoice-matchability'

/** The invoice fields a quote needs (the route also reuses account/contact/description). */
export interface QuotePayment {
  id: string
  account_id: string | null
  contact_id: string | null
  description: string | null
  invoice_number: string | null
  amount: number | string | null
  total: number | string | null
  amount_paid: number | string | null
  card_fee_amount: number | string | null
  amount_currency: string | null
  status: string | null
  invoice_status: string | null
  card_fee_rate: number | string | null
}

export type CardQuoteRefusal = 'not_found' | 'unavailable' | 'paid' | 'closed' | 'nothing_owed' | 'too_small' | 'currency'

export type CardQuote =
  | {
      ok: true
      payment: QuotePayment
      currency: 'usd' | 'eur'
      /** The whole invoice, card fee excluded. */
      invoiceTotal: number
      /** Money already received on it (wire, earlier part payment). */
      alreadyPaid: number
      /** What is still owed — the base of the card price. */
      balance: number
      /** The card fee on the balance (0 when the global switch is off). */
      fee: number
      /** What Stripe is asked to charge: balance + fee. */
      cardTotal: number
      /** The rate actually applied (the invoice's pin; 0 when the switch is off). */
      rate: number
    }
  | { ok: false; reason: CardQuoteRefusal; error: string }

/**
 * Pure: turn an invoice and the resolved charge rate into a quote — or the reason a
 * card payment cannot be started. Uses the SAME closed-invoice rule as the rest of the
 * money code (`isTerminalInvoice`) so the card button never disagrees with the matcher
 * about whether an invoice is still open.
 */
export function buildCardQuote(payment: QuotePayment, rate: number): CardQuote {
  if (payment.status === 'Paid' || payment.invoice_status === 'Paid') {
    return { ok: false, reason: 'paid', error: 'Payment already paid' }
  }
  if (isTerminalInvoice({ status: payment.status, invoice_status: payment.invoice_status })) {
    return { ok: false, reason: 'closed', error: 'This invoice is closed and cannot be paid.' }
  }

  const rawCurrency = (payment.amount_currency || 'USD').toString().toLowerCase()
  if (rawCurrency !== 'usd' && rawCurrency !== 'eur') {
    return { ok: false, reason: 'currency', error: `Unsupported currency: ${payment.amount_currency}` }
  }

  const invoiceTotal = invoiceBaseExFee(payment)
  const balance = balanceOwed(invoiceTotal, payment.amount_paid)
  if (!(balance > 0)) {
    return { ok: false, reason: 'nothing_owed', error: 'Nothing is owed on this invoice.' }
  }

  const { fee, cardTotal, appliedRate } = computeCardTotal(balance, rate)
  if (cardTotal < MIN_CARD_CHARGE) {
    return {
      ok: false,
      reason: 'too_small',
      error: 'The remaining balance is too small to pay by card. Please pay it by bank transfer.',
    }
  }

  return {
    ok: true,
    payment,
    currency: rawCurrency,
    invoiceTotal,
    alreadyPaid: round2(invoiceTotal - balance),
    balance,
    fee,
    cardTotal,
    rate: appliedRate,
  }
}

/**
 * The product name Stripe shows on its payment page. The client sees ONE line there, so
 * it says when the amount is only what is still owed and when a card fee is included —
 * the rate comes from the quote (the invoice's pin), never typed in.
 */
export function stripeProductName(
  description: string | null,
  quote: { alreadyPaid: number; fee: number; rate: number },
): string {
  let name = (description || 'Invoice Payment').trim().slice(0, 120)
  if (quote.alreadyPaid > 0) name += ' — remaining balance'
  if (quote.fee > 0) name += ` + ${Math.round(quote.rate * 10000) / 100}% card fee`
  return name
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- card_fee_rate / card_fee_amount / amount_paid are newer columns than the generated types (repo convention)
const db = () => supabaseAdmin as any

/**
 * Load an invoice by id and quote it. Reads the pinned rate and the global fee switch
 * through `resolveChargeRate`, exactly as the old checkout did.
 */
export async function getCardQuote(paymentId: string): Promise<CardQuote> {
  const { data: payment, error } = await db()
    .from('payments')
    .select('id, account_id, contact_id, description, invoice_number, amount, total, amount_paid, card_fee_amount, amount_currency, status, invoice_status, card_fee_rate')
    .eq('id', paymentId)
    .maybeSingle()
  // A failed lookup is NOT "no such invoice": tell the client to retry instead of
  // making a valid link look void.
  if (error) {
    return { ok: false, reason: 'unavailable', error: 'We could not look up this invoice right now. Please try again in a minute.' }
  }
  if (!payment) {
    return { ok: false, reason: 'not_found', error: 'Payment not found' }
  }

  const rate = await resolveChargeRate((payment as QuotePayment).card_fee_rate)
  return buildCardQuote(payment as QuotePayment, rate)
}
