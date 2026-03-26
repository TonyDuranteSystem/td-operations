import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/service-deliveries — Quick-create a service delivery from CRM chat
 * Admin only.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const body = await request.json()
  const { service_type, account_id, assigned_to, notes } = body

  if (!service_type?.trim()) {
    return NextResponse.json({ error: 'service_type required' }, { status: 400 })
  }
  if (!account_id) {
    return NextResponse.json({ error: 'account_id required' }, { status: 400 })
  }

  // Get company name for service_name
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', account_id)
    .single()

  const serviceName = `${service_type} — ${account?.company_name || 'Unknown'}`
  const now = new Date().toISOString()

  const { data, error } = await supabaseAdmin
    .from('service_deliveries')
    .insert({
      service_type,
      service_name: serviceName,
      account_id,
      assigned_to: assigned_to || 'Luca',
      notes: notes?.trim() || null,
      status: 'Not Started',
      stage: 'intake',
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ id: data.id })
}
