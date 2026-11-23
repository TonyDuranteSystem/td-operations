/**
 * Who referred this company — powers the "Referred by" line on the company page (staff only).
 *
 *  GET /api/referral/referred-by?accountId=<uuid>   →   { referrers: string[] }
 *
 * Read-only. Dashboard-only: a client can never reach it (isDashboardUser). Rules live in lib/referrals.
 */
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { referredByForAccount } from '@/lib/referrals/referral-lookup'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = request.nextUrl.searchParams.get('accountId')
  if (!accountId || !UUID_RE.test(accountId)) return NextResponse.json({ error: 'A valid accountId is required.' }, { status: 400 })

  try {
    return NextResponse.json({ referrers: await referredByForAccount(accountId) })
  } catch (err) {
    console.error('[referral/referred-by]', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not look up who referred this company.' }, { status: 500 })
  }
}
