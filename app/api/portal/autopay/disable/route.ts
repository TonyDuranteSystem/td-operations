import { createClient } from '@/lib/supabase/server'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { disableAutopayCard } from '@/lib/operations/card-autopay'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/autopay/disable
 *
 * Self-service "Turn off Autopay" — detaches the saved card from Stripe and
 * clears the account's autopay flags. Never charges anything.
 *
 * Body: { account_id: string }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { account_id } = body as { account_id?: string }
  if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!(await canAccessAccount(user, account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const result = await disableAutopayCard(account_id)
  if (!result.ok) {
    return NextResponse.json({ error: result.error || 'Failed to disable autopay' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
