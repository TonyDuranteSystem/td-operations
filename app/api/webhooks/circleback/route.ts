/**
 * Circleback Webhook Endpoint
 * Receives call summaries from Circleback via POST webhook.
 * Verifies HMAC-SHA256 signature, stores in call_summaries table,
 * and auto-links to leads by matching attendee email.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  const secret = process.env.CIRCLEBACK_SIGNING_SECRET
  if (!secret) return false
  if (!signature) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return computed === signature
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const signature = req.headers.get('x-signature')

    // Verify HMAC signature if secret is configured
    if (process.env.CIRCLEBACK_SIGNING_SECRET) {
      const valid = await verifySignature(body, signature)
      if (!valid) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    }

    const payload = JSON.parse(body)

    // Extract fields from Circleback payload
    const {
      id: circleback_id,
      title: meeting_name,
      duration,
      meeting_url,
      recording_url,
      attendees = [],
      notes,
      action_items = [],
      transcript = [],
      tags = [],
      ical_uid,
    } = payload

    // Try to match attendee email to a lead
    let lead_id: string | null = null
    let account_id: string | null = null

    if (attendees.length > 0) {
      const attendeeEmails = attendees
        .map((a: { email?: string }) => a.email)
        .filter(Boolean)

      if (attendeeEmails.length > 0) {
        // Match against leads table
        const { data: leads } = await supabase
          .from('leads')
          .select('id')
          .in('email', attendeeEmails)
          .limit(1)

        if (leads && leads.length > 0) {
          lead_id = leads[0].id
        }

        // Also try matching against contacts → accounts
        const { data: contacts } = await supabase
          .from('contacts')
          .select('id, account_id')
          .in('email', attendeeEmails)
          .limit(1)

        if (contacts && contacts.length > 0 && contacts[0].account_id) {
          account_id = contacts[0].account_id
        }
      }
    }

    // Upsert into call_summaries (circleback_id is UNIQUE)
    const record = {
      circleback_id,
      meeting_name,
      duration_seconds: duration,
      meeting_url,
      recording_url,
      attendees,
      notes: typeof notes === 'string' ? notes : JSON.stringify(notes),
      action_items,
      transcript,
      tags: Array.isArray(tags) ? tags : [],
      ical_uid,
      lead_id,
      account_id,
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }

    const { error } = await supabase
      .from('call_summaries')
      .upsert(record, { onConflict: 'circleback_id' })

    if (error) {
      console.error('Circleback webhook: DB insert error', error)
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, lead_id, account_id })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Circleback webhook error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
