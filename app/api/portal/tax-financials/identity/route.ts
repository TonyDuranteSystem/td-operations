/**
 * GET /api/portal/tax-financials/identity?account_id=X — STAFF ONLY.
 *
 * Recall a client's confirm-before-you-open step (Antonio, 2026-08-16):
 * before staff land on a real client's live file, show company name, EIN,
 * and member names so a wrong pick among similarly-named clients is caught
 * before anything opens, not after. Deliberately NOT the full financials
 * view — this is an identity check, not a financial computation, so it
 * reads straight from the account's own CRM record (real name, real EIN,
 * real linked contacts) rather than the client's self-reported wizard data
 * or the computed capital table, either of which could be missing or wrong
 * for exactly the account that most needs a careful look before opening.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const accountId = request.nextUrl.searchParams.get('account_id') ?? ''
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name, ein_number')
    .eq('id', accountId)
    .maybeSingle()
  if (!account) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  const { data: contactRows } = await supabaseAdmin
    .from('account_contacts')
    .select('contacts(full_name)')
    .eq('account_id', accountId)
  const members = ((contactRows ?? []) as Array<{ contacts: { full_name: string | null } | null }>)
    .map(r => r.contacts?.full_name)
    .filter((n): n is string => !!n)

  return NextResponse.json({
    company_name: account.company_name,
    ein_number: account.ein_number,
    members,
  })
}
