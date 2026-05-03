/**
 * POST /api/feed/create-from-feed
 *
 * Bank-Feed-tab variant of the Step 14 create-service-from-feed flow. Where
 * the audit-panel version is account-scoped via URL path
 * (/api/clients/audit/[id]/create-service-from-feed), this one accepts EITHER
 * an account_id OR a contact_id in the body — so a wire from an individual
 * (e.g. Mario Rossi) can be invoiced on the contact alone, even when the
 * contact has no linked account.
 *
 * Body:
 *   {
 *     feed_id: string                            // required
 *     account_id?: string                        // either this
 *     contact_id?: string                        // ...or this (XOR enforced)
 *     service_type?: string                      // required when account_id (creates SD)
 *     service_name?: string                      // optional, falls back to service_type
 *   }
 *
 * Behavior:
 *   - account_id: createBackfilledSD + createTDInvoice + manualMatch (Step 14 flow)
 *   - contact_id: createTDInvoice (no SD — service_deliveries are account-scoped)
 *                 + manualMatch
 *
 * Idempotency: payments.idempotency_key = `feed-flow-create:<feed_id>`
 *
 * Auth: dashboard session (admin staff use the bank-feed UI)
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { manualMatch } from '@/lib/bank-feed-matcher'
import { createBackfilledSD } from '@/lib/operations/service-delivery'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

interface Body {
  feed_id?: string
  account_id?: string
  contact_id?: string
  service_type?: string
  service_name?: string
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const feedId = body.feed_id?.trim()
  const accountId = body.account_id?.trim()
  const contactId = body.contact_id?.trim()
  const serviceType = body.service_type?.trim()
  const serviceName = (body.service_name?.trim() || serviceType || '').slice(0, 200)

  if (!feedId) return NextResponse.json({ error: 'feed_id is required' }, { status: 400 })
  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }
  if (accountId && contactId) {
    return NextResponse.json({ error: 'pass account_id OR contact_id, not both' }, { status: 400 })
  }
  if (accountId && !serviceType) {
    return NextResponse.json({ error: 'service_type required when creating on an account (drives the SD)' }, { status: 400 })
  }

  // 1. Fetch the feed
  const { data: feed, error: feedErr } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, source, transaction_date, amount, currency, sender_name, status, matched_payment_id')
    .eq('id', feedId)
    .single()
  if (feedErr || !feed) {
    return NextResponse.json({ error: `Bank feed not found: ${feedErr?.message ?? 'no row'}` }, { status: 404 })
  }
  if (feed.status === 'matched' && feed.matched_payment_id) {
    return NextResponse.json({ error: 'Bank feed already matched to a payment' }, { status: 409 })
  }

  const idempotencyKey = `feed-flow-create:${feedId}`

  // 2. Idempotency guard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingPayment } = await (supabaseAdmin as any)
    .from('payments')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (existingPayment?.id) {
    return NextResponse.json({ payment_id: existingPayment.id, idempotent: true })
  }

  const currency = (feed.currency || 'USD').toUpperCase()
  const txnDate: string = typeof feed.transaction_date === 'string'
    ? feed.transaction_date.slice(0, 10)
    : new Date(feed.transaction_date as unknown as string | number | Date).toISOString().slice(0, 10)

  // 3. (Account branch) — create the backfilled SD first
  let sdId: string | null = null
  if (accountId) {
    try {
      const sd = await createBackfilledSD({
        account_id: accountId,
        service_type: serviceType!,
        service_name: serviceName,
        amount: Number(feed.amount),
        amount_currency: currency,
        delivered_on: txnDate,
        notes: `Created from bank feed (feed-flow-source:${feedId})`,
      })
      sdId = sd.id
    } catch (err) {
      return NextResponse.json({
        error: `Failed to create service delivery: ${err instanceof Error ? err.message : 'unknown'}`,
      }, { status: 500 })
    }
  }

  // 4. createTDInvoice — paid, idempotent
  const description = serviceName || (contactId ? `Wire payment from ${feed.sender_name ?? 'individual'}` : 'Service')
  let invoice
  try {
    invoice = await createTDInvoice({
      account_id: accountId,
      contact_id: contactId,
      line_items: [{ description, unit_price: Number(feed.amount), quantity: 1 }],
      currency: currency === 'EUR' ? 'EUR' : 'USD',
      mark_as_paid: true,
      paid_date: txnDate,
      payment_method: feed.source,
      idempotency_key: idempotencyKey,
      installment: 'One-Time Service',
      notes: `Bank-feed flow — created from bank feed ${feedId}`,
    })
  } catch (err) {
    if (sdId) {
      await supabaseAdmin.from('service_deliveries').delete().eq('id', sdId)
    }
    return NextResponse.json({
      error: `Failed to create invoice: ${err instanceof Error ? err.message : 'unknown'}`,
    }, { status: 500 })
  }

  // 5. manualMatch
  const matchResult = await manualMatch(feedId, invoice.paymentId)
  if (!matchResult.matched) {
    return NextResponse.json({
      sd_id: sdId,
      payment_id: invoice.paymentId,
      invoice_number: invoice.invoiceNumber,
      warning: `Invoice created, but feed link failed: ${matchResult.error}`,
    })
  }

  return NextResponse.json({
    sd_id: sdId,
    payment_id: invoice.paymentId,
    invoice_number: invoice.invoiceNumber,
  })
}
