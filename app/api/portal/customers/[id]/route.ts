import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { revalidatePath } from 'next/cache'
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
  if (body.first_name !== undefined) updates.first_name = body.first_name || null
  if (body.last_name !== undefined) updates.last_name = body.last_name || null
  if (body.company_name !== undefined) updates.company_name = body.company_name || null
  if (body.email !== undefined) updates.email = body.email || null
  if (body.phone !== undefined) updates.phone = body.phone || null
  if (body.address !== undefined) updates.address = body.address || null
  if (body.city !== undefined) updates.city = body.city || null
  if (body.region !== undefined) updates.region = body.region || null
  if (body.country !== undefined) updates.country = body.country || null
  if (body.vat_number !== undefined) updates.vat_number = body.vat_number || null
  if (body.notes !== undefined) updates.notes = body.notes || null
  const displayName = (body.company_name || '').trim()
    || `${(body.first_name || '').trim()} ${(body.last_name || '').trim()}`.trim()
  if (displayName) updates.name = displayName
  updates.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('client_customers')
    .update(updates)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  revalidatePath('/portal/customers')
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

  revalidatePath('/portal/customers')
  return NextResponse.json({ success: true })
}
