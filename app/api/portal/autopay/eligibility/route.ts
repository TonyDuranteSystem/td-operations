import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isCardAutopayEnabled } from '@/lib/payments/card-autopay-config'
import { isAccountAutopayEnabled } from '@/lib/operations/card-autopay'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/autopay/eligibility?payment_id=X
 *
 * Tells the Pay dialog whether to show the "activate autopay and skip the
 * fee" nudge for THIS invoice: the global switch must be on, the invoice
 * must belong to an account (autopay is account-scoped), and that account
 * must not already be enrolled.
 *
 * Returns: { showPrompt: boolean, accountId: string | null }
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const paymentId = new URL(request.url).searchParams.get('payment_id')
  if (!paymentId) return NextResponse.json({ error: 'payment_id required' }, { status: 400 })

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('account_id')
    .eq('id', paymentId)
    .maybeSingle()

  const accountId = payment?.account_id || null
  if (!accountId) {
    return NextResponse.json({ showPrompt: false, accountId: null })
  }

  if (!(await canAccessAccount(user, accountId, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const [globalEnabled, accountEnrolled] = await Promise.all([
    isCardAutopayEnabled(),
    isAccountAutopayEnabled(accountId),
  ])

  return NextResponse.json({
    showPrompt: globalEnabled && !accountEnrolled,
    accountId,
  })
}
