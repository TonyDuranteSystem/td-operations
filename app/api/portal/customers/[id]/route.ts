import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { revalidatePath } from 'next/cache'
import { NextRequest, NextResponse } from 'next/server'
import { isSafeRecipient } from '@/lib/portal/invoice-email'
import { getTeamMemberHistoryView } from '@/lib/portal/viewer-history'
import { isItemHiddenByCutoff } from '@/lib/documents/history-cutoff'

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
  if (!(await canAccessAccount(user, customer.account_id, 'sales_customers'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // The customer's invoices are invoicing data: a team member who may manage customers but not invoices does not get them.
  const canInvoice = await canAccessAccount(user, customer.account_id, 'invoices_billing')
  const { data: invoices } = canInvoice
    ? await supabaseAdmin
        .from('client_invoices')
        .select('id, invoice_number, status, currency, total, issue_date, created_at')
        .eq('customer_id', id)
        .order('issue_date', { ascending: false })
    : { data: [] as Array<{ id: string; invoice_number: string; status: string; currency: string; total: number; issue_date: string; created_at: string }> }

  // A team member without the "see earlier invoices" option does not get invoices saved before they joined.
  const view = await getTeamMemberHistoryView({ user, accountId: customer.account_id, kind: 'invoice' })
  const visible = (invoices ?? []).filter(i => !isItemHiddenByCutoff({ created_at: i.created_at, opened: view.opened.has(i.id) }, view.cutoff, null))

  return NextResponse.json({ customer, invoices: visible.map(({ created_at: _c, ...rest }) => rest), can_invoice: canInvoice })
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
    .select('account_id, first_name, last_name, company_name')
    .eq('id', id)
    .single()

  if (!customer) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!(await canAccessAccount(user, customer.account_id, 'sales_customers'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  if (body.email && !isSafeRecipient(body.email)) {
    return NextResponse.json({ error: 'That email address does not look valid.' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (body.first_name !== undefined) updates.first_name = body.first_name || null
  if (body.last_name !== undefined) updates.last_name = body.last_name || null
  if (body.company_name !== undefined) updates.company_name = body.company_name || null
  if (body.email !== undefined) updates.email = body.email || null
  if (body.phone !== undefined) updates.phone = body.phone || null
  if (body.address !== undefined) updates.address = body.address || null
  if (body.city !== undefined) updates.city = body.city || null
  if (body.postal_code !== undefined) updates.postal_code = body.postal_code || null
  if (body.region !== undefined) updates.region = body.region || null
  if (body.country !== undefined) updates.country = body.country || null
  if (body.vat_number !== undefined) updates.vat_number = body.vat_number || null
  if (body.notes !== undefined) updates.notes = body.notes || null
  // The display name is worked out from the MERGED values, so sending only a first name no longer wipes the last name.
  const mergedCompany = (body.company_name !== undefined ? body.company_name : customer.company_name) || ''
  const mergedFirst = (body.first_name !== undefined ? body.first_name : customer.first_name) || ''
  const mergedLast = (body.last_name !== undefined ? body.last_name : customer.last_name) || ''
  // Same rule as creating a customer: a first name or a company name. Only blocked when THIS edit would leave a customer
  // that had one with neither (an older customer that only ever had a last name can still have its phone changed).
  const hadNameBefore = !!String(customer.first_name ?? '').trim() || !!String(customer.company_name ?? '').trim()
  const touchesName = body.first_name !== undefined || body.company_name !== undefined
  if (touchesName && hadNameBefore && !String(mergedFirst).trim() && !String(mergedCompany).trim()) {
    return NextResponse.json({ error: 'Keep a first name or a company name for this customer.' }, { status: 400 })
  }
  const displayName = String(mergedCompany).trim() || `${String(mergedFirst).trim()} ${String(mergedLast).trim()}`.trim()
  if (displayName) updates.name = displayName
  updates.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('client_customers')
    .update(updates)
    .eq('id', id)
    .eq('account_id', customer.account_id)

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

  if (!(await canAccessAccount(user, customer.account_id, 'sales_customers'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
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
