import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/payment-settings?account_id=xxx
 * POST /api/portal/payment-settings — Update bank details + payment gateway
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = new URL(request.url).searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!(await canAccessAccount(user, accountId, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data } = await supabaseAdmin
    .from('accounts')
    .select('bank_details, payment_gateway, payment_link')
    .eq('id', accountId)
    .single()

  return NextResponse.json(data ?? { bank_details: null, payment_gateway: null, payment_link: null })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, bank_details, payment_gateway, payment_link } = body

  if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  if (!(await canAccessAccount(user, account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Validate payment_gateway
  if (payment_gateway && !['whop', 'stripe', 'paypal'].includes(payment_gateway)) {
    return NextResponse.json({ error: 'Invalid payment gateway' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (bank_details !== undefined) updates.bank_details = bank_details
  if (payment_gateway !== undefined) updates.payment_gateway = payment_gateway
  if (payment_link !== undefined) updates.payment_link = payment_link

  // eslint-disable-next-line no-restricted-syntax -- pre-existing portal payment-settings write; access now gated via canAccessAccount above
  const { error } = await supabaseAdmin
    .from('accounts')
    .update(updates)
    .eq('id', account_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
