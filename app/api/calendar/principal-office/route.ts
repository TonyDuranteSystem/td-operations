import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { getPrincipalOfficeText } from '@/lib/operations/principal-office'

export const dynamic = 'force-dynamic'

/**
 * GET /api/calendar/principal-office?account_id=…
 * The company's saved Principal Office as one line (null if none), shown in the Annual Report filing question.
 * Staff only.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Staff only' }, { status: 403 })

  const accountId = req.nextUrl.searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id is required' }, { status: 400 })

  try {
    return NextResponse.json({ address: await getPrincipalOfficeText(accountId) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error && err.message ? err.message : 'Could not read the principal office.' }, { status: 500 })
  }
}
