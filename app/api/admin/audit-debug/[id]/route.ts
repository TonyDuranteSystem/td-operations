/**
 * TEMPORARY DEBUG ENDPOINT — replicates the deployed data route logic
 * step by step so we can see why auth_banned_map is wrong for some users.
 * Will be removed after the bug is fixed.
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

  // Step 1
  const { data: links } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id, role')
    .eq('account_id', id)

  const contactIds = (links ?? []).map(l => l.contact_id).filter(Boolean) as string[]

  // Step 2: contacts
  const { data: contactRows } = contactIds.length > 0
    ? await supabaseAdmin.from('contacts').select('id, full_name, email').in('id', contactIds)
    : { data: [] as Array<{ id: string; full_name: string | null; email: string | null }> }

  // Per-email full diagnostic
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perContact: any[] = []
  for (const c of contactRows ?? []) {
    if (!c.email) {
      perContact.push({ contact: c, reason: 'no email' })
      continue
    }
    const user = await findAuthUserByEmail(c.email)
    if (!user) {
      perContact.push({
        contact_email: c.email,
        find_returned: null,
        reason: 'findAuthUserByEmail returned null',
      })
      continue
    }
    const { data: byIdData, error: byIdErr } = await supabaseAdmin.auth.admin.getUserById(user.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bannedUntilRaw = (byIdData?.user as any)?.banned_until ?? null
    const nowMs = Date.now()
    const bannedUntilMs = bannedUntilRaw ? new Date(bannedUntilRaw).getTime() : null
    const computedBanned = !!bannedUntilRaw && bannedUntilMs! > nowMs
    // Try direct SQL read via auth schema
    let directDbBannedUntil: string | null = null
    let directDbError: string | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: dbRow, error: dbErr } = await (supabaseAdmin as any).schema('auth').from('users').select('banned_until').eq('id', user.id).maybeSingle()
      directDbBannedUntil = dbRow?.banned_until ?? null
      directDbError = dbErr?.message ?? null
    } catch (e) {
      directDbError = e instanceof Error ? e.message : String(e)
    }

    perContact.push({
      contact_email: c.email,
      contact_full_name: c.full_name,
      find_user_id: user.id,
      find_user_email: user.email,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      find_user_keys_has_banned_until: 'banned_until' in (user as any),
      get_by_id_user_id: byIdData?.user?.id ?? null,
      get_by_id_error: byIdErr?.message ?? null,
      banned_until_from_get_by_id: bannedUntilRaw,
      banned_until_from_direct_db: directDbBannedUntil,
      direct_db_error: directDbError,
      now: new Date(nowMs).toISOString(),
      banned_until_in_future: computedBanned,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get_by_id_keys: byIdData?.user ? Object.keys(byIdData.user as any) : null,
    })
  }

  return NextResponse.json({
    debug: 'audit-banned-trace',
    timestamp: new Date().toISOString(),
    account_id: id,
    contacts_found: contactRows?.length ?? 0,
    perContact,
  })
}
