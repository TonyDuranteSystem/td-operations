/**
 * Circleback Webhook Endpoint
 * Receives call summaries from Circleback via POST webhook.
 * Verifies HMAC-SHA256 signature, stores in call_summaries table,
 * and auto-links to leads by matching attendee email.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { decideCallLinks, isInternalEmail, normalizeAttendeeEmail } from '@/lib/circleback/link-call'

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

    // ─── WS-D linking (dev job c0a61e44) ───
    // Decision logic is pure + unit-tested (lib/circleback/link-call.ts):
    // normalize emails, skip notetakers + internal attendees, match leads AND
    // contacts case-insensitively, link only when exactly ONE distinct client
    // identity matches — anything ambiguous records a review reason instead
    // (a transcript filed on the wrong client is worse than an unlinked call).
    const db = getSupabase()
    const externalEmails = Array.from(
      new Set(
        (attendees as Array<{ email?: string | null }>)
          .map((a) => normalizeAttendeeEmail(a.email))
          .filter((e): e is string => !!e && !isInternalEmail(e)),
      ),
    )

    let leadRows: Array<{ id: string; email: string }> = []
    let contactRows: Array<{ id: string; email: string }> = []
    let candidateFetchError: string | null = null
    if (externalEmails.length > 0) {
      // ILIKE metacharacters escaped (hunter finding 3): an underscore in a real
      // email must not pattern-match a near-collision row. decideCallLinks also
      // exact-intersects candidate emails as defense-in-depth.
      const orExpr = externalEmails
        .map((e) => `email.ilike.${e.replace(/([%_])/g, '\\$1')}`)
        .join(',')
      const [leadRes, contactRes] = await Promise.all([
        db.from('leads').select('id, email').or(orExpr),
        db.from('contacts').select('id, email').or(orExpr),
      ])
      // A lookup failure must NOT read as "no match" (hunter finding 4): the
      // call would be stored silently unlinked with no marker. Record it.
      if (leadRes.error || contactRes.error) {
        candidateFetchError = leadRes.error?.message || contactRes.error?.message || 'unknown'
        console.error('[circleback] candidate lookup failed:', candidateFetchError)
      }
      leadRows = (leadRes.data ?? []) as Array<{ id: string; email: string }>
      contactRows = (contactRes.data ?? []) as Array<{ id: string; email: string }>
    }

    const decision = decideCallLinks(attendees as Array<{ email?: string | null }>, {
      leads: leadRows,
      contacts: contactRows,
    })

    // Account: only when the linked contact belongs to exactly ONE account.
    let account_id: string | null = null
    if (decision.contact_id) {
      const { data: links } = await db
        .from('account_contacts')
        .select('account_id')
        .eq('contact_id', decision.contact_id)
        .limit(2)
      if (links && links.length === 1) {
        account_id = (links[0] as { account_id: string }).account_id
      }
    }

    // Re-delivery must NEVER clobber existing links (auto or manual): fetch the
    // current row and fill link fields only where they are currently empty.
    const { data: existingRow } = await db
      .from('call_summaries')
      .select('id, lead_id, contact_id, account_id, link_review')
      .eq('circleback_id', circleback_id)
      .maybeSingle()
    const ex = existingRow as
      | { id: string; lead_id: string | null; contact_id: string | null; account_id: string | null; link_review: string | null }
      | null

    const finalLeadId = ex?.lead_id ?? decision.lead_id
    const finalContactId = ex?.contact_id ?? decision.contact_id
    const finalAccountId = ex?.account_id ?? account_id
    // Review marker: pointless once any link exists; otherwise keep/set the
    // reason — and a failed candidate lookup is its own reason (finding 4),
    // never indistinguishable from a genuine no-match.
    const finalReview = finalLeadId || finalContactId || finalAccountId
      ? null
      : (ex?.link_review
          ?? decision.review
          ?? (candidateFetchError ? `auto-link deferred: candidate lookup failed (${candidateFetchError}) — link manually` : null))

    const lead_id = finalLeadId

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
      lead_id: finalLeadId,
      contact_id: finalContactId,
      account_id: finalAccountId,
      link_review: finalReview,
      raw_payload: payload,
      updated_at: new Date().toISOString(),
    }

    const { error } = await db
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
