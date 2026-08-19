/**
 * GET /api/portal/tax-financials/identity?account_id=X — STAFF ONLY.
 *
 * Recall a client's confirm-before-you-open step (Antonio, 2026-08-16):
 * before staff land on a real client's live file, show company name, EIN,
 * and member names so a wrong pick among similarly-named clients is caught
 * before anything opens, not after. Deliberately NOT the full financials
 * view — this is an identity check, not a financial computation.
 *
 * REVISED 2026-08-19: the member list now goes through fetchMemberRoster
 * (lib/tax/member-roster.ts) instead of a raw account_contacts scan. That
 * scan had the same "null null" defect fixed the same day in the
 * bank-statement P&L tool, and — worse on THIS screen specifically — it
 * silently missed any member whose only record is a company name (no linked
 * contact at all), so a company owner could be absent from the very check
 * meant to catch a wrong pick. fetchMemberRoster still reads the account's
 * curated members first; it only widens to linked contacts (which can
 * include client-submitted member info) as a documented fallback for
 * accounts with no curated roster — the original goal (don't trust only
 * self-reported data) is why the roster is members-first, not contacts-only.
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

  const { fetchMemberRoster } = await import('@/lib/tax/member-roster')
  const { names: members } = await fetchMemberRoster(supabaseAdmin, accountId)

  return NextResponse.json({
    company_name: account.company_name,
    ein_number: account.ein_number,
    members,
  })
}
