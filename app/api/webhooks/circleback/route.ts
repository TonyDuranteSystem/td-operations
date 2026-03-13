/**
 * Circleback Webhook Endpoint
 * Receives call summaries from Circleback via POST webhook.
 * Verifies HMAC-SHA256 signature, stores in call_summaries table,
 * and auto-links to leads by matching attendee email.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _supabase: SupabaseClient | null = null
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _supabase
}

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

    // Extract fields from Circleback payload (camelCase from API)
    const {
      id,
      name: meeting_name,
      duration,
      url: meeting_url,
      recordingUrl: recording_url,
      attendees = [],
      notes,
      actionItems = [],
      transcript = [],
      tags = [],
      icalUid: ical_uid,
    } = payload

    // Circleback sends id as number, our column is TEXT
    const circleback_id = String(id)

    // Try to match attendee email to a lead
    let lead_id: string | null = null

    if (attendees.length > 0) {
      const attendeeEmails = attendees
        .map((a: { email?: string }) => a.email)
        .filter(Boolean)

      if (attendeeEmails.length > 0) {
        const { data: leads } = await getSupabase()
          .from('leads')
          .select('id')
          .in('email', attendeeEmails)
          .limit(1)

        if (leads && leads.length > 0) {
          lead_id = leads[0].id
        }
      }
    }

    // Upsert into call_summaries (circleback_id is UNIQUE)
    const record = {
      circleback_id,
      meeting_name,
      duration_seconds: duration != null ? Math.round(Number(duration)) : null,
      meeting_url,
      recording_url,
      attendees,
      notes: typeof notes === 'string' ? notes : JSON.stringify(notes),
      action_items: actionItems,
      transcript,
      tags: Array.isArray(tags) ? tags : [],
      ical_uid,
      lead_id,
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }

    const { error } = await getSupabase()
      .from('call_summaries')
      .upsert(record, { onConflict: 'circleback_id' })

    if (error) {
      console.error('Circleback webhook: DB insert error', error)
      console.error('Circleback webhook: record keys', Object.keys(record))
      console.error('Circleback webhook: duration type', typeof duration, duration)
      console.error('Circleback webhook: circleback_id type', typeof circleback_id, circleback_id)
      console.error('Circleback webhook: tags', JSON.stringify(tags))
      return NextResponse.json({ error: 'Database error', details: error.message, code: error.code, hint: error.hint }, { status: 500 })
    }

    return NextResponse.json({ ok: true, lead_id })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('Circleback webhook error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
