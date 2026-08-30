import { createClient } from '@/lib/supabase/server'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isCardAutopayEnabled } from '@/lib/payments/card-autopay-config'
import { getOrCreateStripeCustomerForAccount, createAutopaySetupCheckoutSession } from '@/lib/operations/card-autopay'
import { PORTAL_BASE_URL } from '@/lib/config'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * POST /api/portal/autopay/setup-checkout
 *
 * Starts card-autopay enrollment: creates/reuses a Stripe Customer for the
 * account and returns a Stripe Checkout Session URL in "setup" mode (card
 * saved on-session, nothing charged). The webhook's setup-mode branch
 * (app/api/webhooks/stripe/route.ts) finishes enrollment once the client
 * completes the Stripe-hosted page.
 *
 * Body: { account_id: string }
 * Returns: { checkoutUrl }
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

  if (!(await isCardAutopayEnabled())) {
    return NextResponse.json({ error: 'Card autopay is not available yet' }, { status: 403 })
  }

  const customerResult = await getOrCreateStripeCustomerForAccount(account_id)
  if ('error' in customerResult) {
    return NextResponse.json({ error: customerResult.error }, { status: 500 })
  }

  const sessionResult = await createAutopaySetupCheckoutSession({
    accountId: account_id,
    customerId: customerResult.customerId,
    returnUrl: `${PORTAL_BASE_URL}/portal/invoices?tab=expenses`,
  })
  if ('error' in sessionResult) {
    return NextResponse.json({ error: sessionResult.error }, { status: 500 })
  }

  return NextResponse.json({ checkoutUrl: sessionResult.url })
}
