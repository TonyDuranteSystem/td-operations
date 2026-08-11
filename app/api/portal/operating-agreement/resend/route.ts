/**
 * POST /api/portal/operating-agreement/resend
 *
 * Client self-service: re-issue the co-signer signing links for an account's live
 * Operating Agreement. This is how a client fixes an EXPIRED link himself, with no
 * staff involvement (Antonio, 2026-08-11: "the client re-issues fresh links himself
 * from his portal").
 *
 * For every UNSIGNED, NON-REVOKED signer row it:
 *   - rotates the per-signer access code (a fresh 128-bit code — the old emailed
 *     link is now dead),
 *   - re-stamps a fresh 15-day expiry,
 *   - re-emails that one member their personal link — EMAIL ONLY. The link carries
 *     the signing credential, and portal chat / the bell are readable by every
 *     linked contact on the company, so a credential must never travel there.
 *
 * What it deliberately does NOT do:
 *   - touch a SIGNED row (never un-signs anyone),
 *   - touch a REVOKED row. Revocation means the roster changed under a
 *     partially-signed agreement; those are reissued by staff (void + regenerate),
 *     not silently re-armed here — so a re-send after a roster change is a no-op
 *     and tells the client to contact support.
 *   - act on a signed or voided agreement (refused).
 *
 * Rate-limited to one re-send per agreement per hour, keyed on the rows' own
 * sent_at (DB-backed, so it holds across serverless instances).
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { normalizeEntityType } from '@/lib/portal/entity-type'
import { APP_BASE_URL } from '@/lib/config'
import { notifyClientActionRequired } from '@/lib/portal/action-required'
import { signerLinkExpiryISO } from '@/lib/oa/public-view'

const RESEND_COOLDOWN_MS = 60 * 60 * 1000 // one re-send per agreement per hour

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

function genCode(): string {
  return randomUUID().replace(/-/g, '')
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked to your account' }, { status: 403 })

  let body: { account_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const accountId = body.account_id
  if (!accountId) return NextResponse.json({ error: 'account_id is required' }, { status: 400 })

  // Only the account's own portal principal may re-issue its links.
  const accessibleIds = await getClientAccountIds(contactId)
  if (!accessibleIds.includes(accountId)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // The newest live agreement (same resolution the sign page uses).
  const { data: oa } = await db
    .from('oa_agreements')
    .select('id, token, access_code, status, company_name, entity_type')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!oa) return NextResponse.json({ error: 'No Operating Agreement found.' }, { status: 404 })
  if (oa.status === 'signed') {
    return NextResponse.json({ error: 'This Operating Agreement is already fully signed.' }, { status: 409 })
  }
  if (oa.status === 'voided') {
    return NextResponse.json({ error: 'This Operating Agreement is outdated. Please generate a new one.' }, { status: 409 })
  }
  if (normalizeEntityType(oa.entity_type) !== 'MMLLC') {
    return NextResponse.json({ error: 'This is a single-member agreement — sign it directly from your portal.' }, { status: 400 })
  }

  const { data: sigRows } = await db
    .from('oa_signatures')
    .select('id, member_index, member_name, member_email, contact_id, status, revoked_at, sent_at, link_expires_at')
    .eq('oa_id', oa.id)
    .order('member_index')
  const rows = sigRows ?? []

  // Candidates: unsigned AND not revoked. A revoked row (roster changed) is not
  // re-armed here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = rows.filter((r: any) => r.status !== 'signed' && !r.revoked_at)
  if (candidates.length === 0) {
    // Distinguish "nothing to do because everyone signed" from "all links were
    // revoked by a roster change" so the client gets an accurate next step.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyRevoked = rows.some((r: any) => r.revoked_at && r.status !== 'signed')
    return NextResponse.json({
      error: anyRevoked
        ? 'The member list changed, so these links were reset. Please contact support@tonydurante.us to have fresh ones issued.'
        : 'There are no pending signatures to re-send.',
    }, { status: 409 })
  }

  // Rate limit: one re-send per hour, from the rows' own sent_at (DB-backed).
  const now = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastSent = candidates.reduce((max: number, r: any) => {
    const t = r.sent_at ? new Date(r.sent_at).getTime() : 0
    return t > max ? t : max
  }, 0)
  if (lastSent && now - lastSent < RESEND_COOLDOWN_MS) {
    const mins = Math.ceil((RESEND_COOLDOWN_MS - (now - lastSent)) / 60000)
    return NextResponse.json(
      { error: `Fresh links were just sent. Please wait about ${mins} minute${mins === 1 ? '' : 's'} before sending again.` },
      { status: 429 },
    )
  }

  const nowIso = new Date().toISOString()
  const expiry = signerLinkExpiryISO(now)
  let reissued = 0

  for (const row of candidates) {
    const newCode = genCode()
    // Rotate the per-signer code + fresh expiry + mark sent. Guarded so a signature
    // landing in the gap, or a concurrent revoke, is not overwritten.
    const { data: updated } = await db
      .from('oa_signatures')
      .update({ access_code: newCode, link_expires_at: expiry, sent_at: nowIso, status: 'sent', updated_at: nowIso })
      .eq('id', row.id)
      .neq('status', 'signed')
      .is('revoked_at', null)
      .select('id')
    if (!updated || updated.length === 0) continue

    if (!row.contact_id) continue
    const signerUrl = `${APP_BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?portal=true&signer=${newCode}`
    await notifyClientActionRequired({
      contact_id: row.contact_id,
      account_id: accountId,
      topic: 'Operating Agreement',
      title: {
        en: `Your new signing link for ${oa.company_name}`,
        it: `Il tuo nuovo link di firma per ${oa.company_name}`,
      },
      message: {
        en: `Here is a fresh link to sign the Operating Agreement for ${oa.company_name}. It is valid for 15 days.`,
        it: `Ecco un nuovo link per firmare l'Atto Costitutivo di ${oa.company_name}. È valido per 15 giorni.`,
      },
      // Unique per (agreement, member) so the dedup scope changes each reissue.
      link: `/portal/sign/oa?account=${accountId}&oa=${oa.id}`,
      emailLink: signerUrl,
    }).catch(() => {})
    reissued += 1
  }

  return NextResponse.json({ success: true, reissued })
}
