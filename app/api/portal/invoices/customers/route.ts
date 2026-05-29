import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/invoices/customers?account_id=xxx
 * Returns customer list for an account (for invoice form dropdown)
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = new URL(request.url).searchParams.get('account_id')
  if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })

  // Access control — default-deny (contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, accountId, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data } = await supabaseAdmin
    .from('client_customers')
    .select('id, name, email')
    .eq('account_id', accountId)
    .order('name')

  return NextResponse.json(data ?? [])
}
