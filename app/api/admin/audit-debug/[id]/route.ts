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
      .select('contact_id, role')
      .eq('account_id', id),
  ])

  // Two-step contact fetch (matches new data route)
  const linkedContactIds = (contactsRes.data ?? []).map(r => r.contact_id).filter(Boolean) as string[]
  const { data: contactRows } = linkedContactIds.length > 0
    ? await supabaseAdmin
        .from('contacts')
        .select('id, full_name, email, portal_tier')
        .in('id', linkedContactIds)
    : { data: [] as Array<{ id: string; full_name: string | null; email: string | null; portal_tier: string | null }> }

  const contacts = (contactRows ?? []).map(c => ({
    id: c.id as string,
    full_name: (c.full_name ?? '') as string,
    email: (c.email ?? '') as string,
    portal_tier: c.portal_tier as string | null,
  }))

  const authUserMap: Record<string, boolean> = {}
  const authBannedMap: Record<string, boolean> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authUserDetails: Record<string, any> = {}
  for (const c of contacts) {
    if (!c?.email) continue
    const user = await findAuthUserByEmail(c.email)
    authUserMap[c.email] = !!user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bannedUntilFromList = (user as any)?.banned_until ?? null
    // Compare against getUserById, which may return different shape
    let getByIdResult = null
    if (user) {
      const { data: byId } = await supabaseAdmin.auth.admin.getUserById(user.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getByIdResult = byId?.user ? { banned_until: (byId.user as any).banned_until ?? null, all_keys: Object.keys(byId.user) } : null
    }
    const bannedUntil = bannedUntilFromList || getByIdResult?.banned_until || null
    const banned = !!bannedUntil && new Date(bannedUntil) > new Date()
    authBannedMap[c.email] = banned
    if (user) authUserDetails[c.email] = {
      id: user.id,
      banned_until_from_listUsers: bannedUntilFromList,
      banned_until_from_getUserById: getByIdResult?.banned_until ?? null,
      list_user_keys: Object.keys(user),
      get_by_id_keys: getByIdResult?.all_keys ?? null,
    }
  }

  // Diagnostics — what env / key is the runtime using?
  const envSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? null
  const expectedRef = process.env.EXPECTED_SUPABASE_REF ?? null
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const keyPrefix = serviceKey.slice(0, 12)
  const keyLen = serviceKey.length

  // Try the same query without any embed — maybe RLS / relation issue
  const directRes = await supabaseAdmin
    .from('account_contacts')
    .select('account_id, contact_id, role')
    .eq('account_id', id)

  // Count all account_contacts rows visible to service role
  const { count: totalLinks } = await supabaseAdmin
    .from('account_contacts')
    .select('*', { count: 'exact', head: true })

  return NextResponse.json({
    debug: 'audit-data-mirror',
    timestamp: new Date().toISOString(),
    runtime: {
      NEXT_PUBLIC_SUPABASE_URL: envSupabaseUrl,
      EXPECTED_SUPABASE_REF: expectedRef,
      SUPABASE_SERVICE_ROLE_KEY_prefix: keyPrefix,
      SUPABASE_SERVICE_ROLE_KEY_length: keyLen,
    },
    account: accountRes.data,
    contacts_with_tier: contacts,
    auth_user_map: authUserMap,
    auth_banned_map: authBannedMap,
    auth_user_details: authUserDetails,
    raw_contacts_res: contactsRes.data,
    raw_contacts_error: contactsRes.error,
    direct_account_contacts_query: directRes.data,
    direct_query_error: directRes.error,
    total_account_contacts_rows_visible: totalLinks,
  })
}
