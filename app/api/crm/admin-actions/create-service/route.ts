import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/crm/admin-actions/create-service
 * Create a service delivery for an account.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { account_id, contact_id, service_type, notes } = body

  if (!service_type) {
    return NextResponse.json({ error: 'service_type is required' }, { status: 400 })
  }
  if (!account_id && !contact_id) {
    return NextResponse.json({ error: 'account_id or contact_id is required' }, { status: 400 })
  }

  // Get account name for service_name
  let serviceName = service_type
  if (account_id) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', account_id)
      .single()
    if (account) serviceName = `${service_type} — ${account.company_name}`
  }

  const { data, error } = await supabaseAdmin
    .from('service_deliveries')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
      service_type,
      service_name: serviceName,
      stage: 'Data Collection',
      stage_order: 1,
      status: 'active',
      start_date: new Date().toISOString().split('T')[0],
      assigned_to: 'Luca',
      notes: notes || null,
    })
    .select('id, service_name, service_type, stage, status')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data })
}
