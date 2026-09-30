import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { clientIp } from '@/lib/esign/request-meta'
import { checkLoginRateLimit, recordLoginFailure, clearLoginFailures } from '@/lib/portal/rate-limit'
import { readOfferRequest } from '@/lib/offers/public-offer-request'
import { hasStaffSession } from '@/lib/offers/public-offer-access'
import { timingSafeStrEqual } from '@/lib/esign/access-guard'

export const dynamic = 'force-dynamic'

/**
 * POST /api/offers/gate — the email gate of the plain offer link (N0, dev job f907220c).
 *
 *   { token, action: 'info' }  → { language }   (renders the gate; same answer for unknown tokens)
 *   { token, email }           → { code }       when the email matches the offer's client email
 *   { token, preview: 'td' }   → { code }       for a genuine admin/team session only
 *
 * The emailed link is /offer/<token> with no access code. Before N0 the page fetched
 * the WHOLE offer (access code included) and compared the email in the browser, so
 * the "gate" protected nothing. Now the comparison happens here and the only thing
 * returned is the access code, which the page then carries (/offer/<token>/<code>),
 * exactly like the six client forms' gates.
 *
 * Refuses when the offer has no client email on file (never "empty equals empty").
 * Rate-limited per (IP, token) — the token is guessable (name + year) and a client's
 * email often is too. An unknown token answers exactly like a wrong email, so the
 * gate never confirms that someone is a client.
 */
export async function POST(req: NextRequest) {
  const { body, token, preview } = await readOfferRequest(req)
  if (!token) return NextResponse.json({ error: 'Missing offer link.' }, { status: 400 })

  const { data: offer } = await supabaseAdmin
    .from('offers')
    .select('token, client_email, access_code, language')
    .eq('token', token)
    .maybeSingle()

  if (body.action === 'info') {
    return NextResponse.json({ language: offer?.language === 'en' ? 'en' : 'it' })
  }

  if (preview && offer?.access_code && (await hasStaffSession())) {
    return NextResponse.json({ code: String(offer.access_code) })
  }

  const key = `offer-gate:${clientIp(req) || 'unknown'}:${token}`
  const rl = checkLoginRateLimit(key)
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes and try again.' }, { status: 429 })
  }

  const onFile = String(offer?.client_email || '').toLowerCase().trim()
  const typed = String(body.email || '').toLowerCase().trim()
  if (offer?.access_code && !onFile) {
    return NextResponse.json(
      { error: 'Please open this offer from the link in your client portal, or contact us.' },
      { status: 403 },
    )
  }
  if (!offer?.access_code || !typed || !timingSafeStrEqual(onFile, typed)) {
    recordLoginFailure(key)
    return NextResponse.json({ error: 'email_mismatch' }, { status: 403 })
  }
  clearLoginFailures(key)
  return NextResponse.json({ code: String(offer.access_code) })
}
