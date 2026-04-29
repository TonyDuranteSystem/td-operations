/**
 * TEMPORARY DEBUG ENDPOINT — delete after audit-panel issue is resolved.
 *
 * Calls the same data-fetching logic the audit panel uses, gated by
 * API_SECRET_TOKEN so it can be hit from a terminal without a session.
 * Lets me see the exact JSON shape the deployed route returns for a
 * specific account, to diagnose why Future Marketing LLC's contact is
 * not rendering in the Portal Visibility section.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token || token !== process.env.API_SECRET_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = params.id

  const [accountRes, contactsRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('accounts')
      .select('id, company_name, portal_account, portal_tier, entity_type, audit_sections')
      .eq('id', id)
      .single(),
    supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role, contacts(id, full_name, email, portal_tier)')
      .eq('account_id', id),
  ])

  // Mirror the data route logic exactly
  const contacts = (contactsRes.data ?? []).map(r => r.contacts as unknown as {
    id: string; full_name: string; email: string; portal_tier: string | null
  } | null).filter(Boolean)

  const authUserMap: Record<string, boolean> = {}
  const authBannedMap: Record<string, boolean> = {}
  const authUserDetails: Record<string, { id: string; banned_until: string | null }> = {}
  for (const c of contacts) {
    if (!c?.email) continue
    const user = await findAuthUserByEmail(c.email)
    authUserMap[c.email] = !!user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bannedUntil = (user as any)?.banned_until ?? null
    const banned = !!bannedUntil && new Date(bannedUntil) > new Date()
    authBannedMap[c.email] = banned
    if (user) authUserDetails[c.email] = { id: user.id, banned_until: bannedUntil }
  }

  return NextResponse.json({
    debug: 'audit-data-mirror',
    timestamp: new Date().toISOString(),
    account: accountRes.data,
    contacts_with_tier: contacts,
    auth_user_map: authUserMap,
    auth_banned_map: authBannedMap,
    auth_user_details: authUserDetails,
    raw_contacts_res: contactsRes.data,
    raw_contacts_error: contactsRes.error,
  })
}
