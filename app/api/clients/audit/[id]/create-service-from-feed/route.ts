/**
 * POST /api/clients/audit/[id]/create-service-from-feed
 *
 * Step 14 of the billing audit (ops-2026-05-02-billing-bank-audit-plan v2.2,
 * Track B). Triggered from the audit panel "Create service" action on an
 * orphan bank-feed row.
 *
 * Flow:
 *   1. Verify the feed exists and isn't already matched.
 *   2. Idempotent guard: if a payment with key `audit-create-service:<feed_id>`
 *      already exists, return cached ids — no double-write.
 *   3. INSERT service_deliveries (status=Completed, stage=Delivered,
 *      dates=feed.transaction_date, amount+currency from the feed).
 *   4. createTDInvoice with mark_as_paid=true (writes payments + mirrors to
 *      client_expenses), idempotency_key as above.
 *   5. manualMatch(feed_id, payment_id) — links the feed and reuses the
 *      finance team's existing match path.
 *   6. Return { sd_id, payment_id }.
 *
 * Auth: requireStaffRoute() (lib/auth/require-staff-route.ts) — the "middleware-protected,
 * no per-route check" comment this replaced was FALSE (security audit,
 * 2026-08-21, dev job 9d80395e-cef4-4c76-998b-c23a5f99684b): middleware never
 * checks role on /api/* paths, only on dashboard page navigations.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { manualMatch } from '@/lib/bank-feed-matcher'
import { createBackfilledSD } from '@/lib/operations/service-delivery'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

export const dynamic = 'force-dynamic'

interface CreateServiceBody {
  feed_id?: string
  service_type?: string
  service_name?: string
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const accountId = params.id
  let body: CreateServiceBody
  try {
    body = (await req.json()) as CreateServiceBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const feedId = body.feed_id?.trim()
  const serviceType = body.service_type?.trim()
  const serviceName = (body.service_name?.trim() || serviceType || '').slice(0, 200)

  if (!feedId) return NextResponse.json({ error: 'feed_id is required' }, { status: 400 })
  if (!serviceType) return NextResponse.json({ error: 'service_type is required' }, { status: 400 })
  if (!serviceName) return NextResponse.json({ error: 'service_name is required' }, { status: 400 })

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

  const idempotencyKey = `audit-create-service:${feedId}`

  // 2. Idempotency guard — has this exact create-service op already happened?
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingPayment } = await (supabaseAdmin as any)
    .from('payments')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (existingPayment?.id) {
    // Find the SD created in the prior run (linked by the same notes marker)
    const { data: existingSd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id')
      .eq('account_id', accountId)
      .ilike('notes', `%audit-source-feed:${feedId}%`)
      .maybeSingle()
    return NextResponse.json({
      sd_id: existingSd?.id ?? null,
      payment_id: existingPayment.id,
      idempotent: true,
    })
  }

  // 3. INSERT service_deliveries via lib/operations helper (P2.4 compliance)
  const currency = (feed.currency || 'USD').toUpperCase()
  const txnDate: string = typeof feed.transaction_date === 'string'
    ? feed.transaction_date.slice(0, 10)
    : new Date(feed.transaction_date as unknown as string | number | Date).toISOString().slice(0, 10)

  let sdRow: { id: string }
  try {
    sdRow = await createBackfilledSD({
      account_id: accountId,
      service_type: serviceType,
      service_name: serviceName,
      amount: Number(feed.amount),
      amount_currency: currency,
      delivered_on: txnDate,
      notes: `Created during billing audit from bank feed (audit-source-feed:${feedId})`,
    })
  } catch (err) {
    return NextResponse.json({
      error: `Failed to create service delivery: ${err instanceof Error ? err.message : 'unknown'}`,
    }, { status: 500 })
  }

  // 4. createTDInvoice — paid, idempotent
  let invoice
  try {
    invoice = await createTDInvoice({
      account_id: accountId,
      line_items: [{ description: serviceName, unit_price: Number(feed.amount), quantity: 1 }],
      currency: currency === 'EUR' ? 'EUR' : 'USD',
      mark_as_paid: true,
      paid_date: txnDate,
      payment_method: feed.source,
      idempotency_key: idempotencyKey,
      installment: 'One-Time Service',
      notes: `Audit pass — created from bank feed ${feedId}`,
    })
  } catch (err) {
    // Roll back the SD if invoice creation fails — keeps state consistent
    await supabaseAdmin.from('service_deliveries').delete().eq('id', sdRow.id)
    return NextResponse.json({
      error: `Failed to create invoice: ${err instanceof Error ? err.message : 'unknown'}`,
    }, { status: 500 })
  }

  // 5. manualMatch — link feed → payment, mark feed matched, sync invoice/QB
  const matchResult = await manualMatch(feedId, invoice.paymentId)
  if (!matchResult.matched) {
    // Don't roll back the SD/invoice — they're real. Just surface the warning.
    return NextResponse.json({
      sd_id: sdRow.id,
      payment_id: invoice.paymentId,
      invoice_number: invoice.invoiceNumber,
      warning: `Service + invoice created, but feed link failed: ${matchResult.error}`,
    })
  }

  return NextResponse.json({
    sd_id: sdRow.id,
    payment_id: invoice.paymentId,
    invoice_number: invoice.invoiceNumber,
  })
}
