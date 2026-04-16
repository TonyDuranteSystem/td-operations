import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { createSD } from '@/lib/operations/service-delivery'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/crm/admin-actions/create-service
 * Create a service delivery for an account.
 *
 * Routes through lib/operations/service-delivery.createSD so the stage is
 * resolved from pipeline_stages (not hardcoded "Data Collection" which is
 * only valid for a few service_types — see dev_task 6d2a2be1).
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

  try {
    const data = await createSD({
      service_type,
      service_name: serviceName,
      account_id: account_id || null,
      contact_id: contact_id || null,
      notes: notes || undefined,
    })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
