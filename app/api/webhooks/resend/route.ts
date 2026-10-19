/**
 * Webhook: Resend — did a client's invoice email actually reach the customer?
 *
 * Resend accepts an email first and tells us later what happened (delivered / delayed / bounced / blocked). We write that
 * onto the email's tracking row; the client's invoice page and list then show a clear "not delivered" warning.
 * The invoice's own status (Sent) is NOT touched: it still means "the client sent it".
 *
 * Setup (Antonio, in the Resend dashboard): Webhooks → Add endpoint → URL <production domain>/api/webhooks/resend,
 * events email.delivered, email.delivery_delayed, email.bounced, email.suppressed, email.failed. Copy the signing secret
 * (starts with whsec_) into the Vercel env var RESEND_WEBHOOK_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { interpretResendEvent, shouldApplyDelivery, verifySvixSignature } from '@/lib/portal/resend-webhook'
import type { Json } from '@/lib/database.types'

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  // Not set up yet: say so (503), so Resend retries later instead of dropping the event.
  if (!secret) return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 503 })

  const payload = await req.text() // the RAW body: the signature breaks if it is parsed and re-written
  const svixId = req.headers.get('svix-id')
  if (!verifySvixSignature({
    secret,
    id: svixId,
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    payload,
  })) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try { body = JSON.parse(payload) } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Keep a copy of every event (audit trail, the same table the other webhooks use). Never blocks the real work.
  const eventType = (body as { type?: unknown })?.type
  void supabaseAdmin.from('webhook_events').insert({
    source: 'resend',
    event_type: typeof eventType === 'string' ? eventType : 'unknown',
    external_id: svixId,
    payload: body as Json,
  }).then(() => undefined, () => undefined)

  const update = interpretResendEvent(body)
  if (!update) return NextResponse.json({ ok: true, ignored: true }) // an event that says nothing about delivery

  const { data: row, error: findErr } = await supabaseAdmin
    .from('email_tracking')
    .select('id, delivery_status')
    .eq('gmail_message_id', update.emailId) // for Resend sends this column holds Resend's email id
    .maybeSingle()
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 }) // Resend retries
  if (!row) return NextResponse.json({ ok: true, ignored: true }) // not an email of ours that we track

  if (!shouldApplyDelivery(row.delivery_status, update.status)) return NextResponse.json({ ok: true, unchanged: true })

  const { error: updErr } = await supabaseAdmin
    .from('email_tracking')
    .update({ delivery_status: update.status, delivery_detail: update.detail, delivery_updated_at: new Date().toISOString() })
    .eq('id', row.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
