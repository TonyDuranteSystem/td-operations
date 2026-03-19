import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/customers/[id] — Customer detail + their invoices
 * PATCH /api/portal/customers/[id] — Update customer
 * DELETE /api/portal/customers/[id] — Delete customer (only if no invoices)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('*')
    .eq('id', id)
    .single()

  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(customer.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Get invoices for this customer
  const { data: invoices } = await supabaseAdmin
    .from('client_invoices')
    .select('id, invoice_number, status, currency, total, issue_date')
    .eq('customer_id', id)
    .order('issue_date', { ascending: false })

  return NextResponse.json({ customer, invoices: invoices ?? [] })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()

  // Verify ownership
  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('account_id')
    .eq('id', id)
    .single()

  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(customer.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.email !== undefined) updates.email = body.email || null
  if (body.address !== undefined) updates.address = body.address || null
  if (body.vat_number !== undefined) updates.vat_number = body.vat_number || null
  if (body.notes !== undefined) updates.notes = body.notes || null
  updates.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('client_customers')
    .update(updates)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Verify ownership
  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('account_id')
    .eq('id', id)
    .single()

  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(customer.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Check for invoices — don't delete if has invoices
  const { count } = await supabaseAdmin
    .from('client_invoices')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', id)

  if (count && count > 0) {
    return NextResponse.json({ error: 'Cannot delete customer with invoices' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from('client_customers').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
