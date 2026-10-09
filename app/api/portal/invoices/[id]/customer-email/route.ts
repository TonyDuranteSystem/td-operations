import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isPlausibleEmail } from '@/lib/portal/invoice-send-notices'
import { NextRequest, NextResponse } from 'next/server'

/**
 * PATCH /api/portal/invoices/[id]/customer-email — set the email of the customer this invoice is for.
 *
 * Narrow on purpose: it changes ONE field (email) of the invoice's own customer, so the "Add email"
 * button on a draft invoice works for anyone who may use invoices, without also granting the wider
 * right to edit customers. Gate = the same invoices_billing check as send/pdf.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: invoice } = await supabaseAdmin
    .from('client_invoices')
    .select('account_id, customer_id')
    .eq('id', id)
    .single()
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!(await canAccessAccount(user, invoice.account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }
  if (!invoice.customer_id) {
    return NextResponse.json({ error: 'This invoice has no customer.' }, { status: 400 })
  }

  const body = await request.json().catch(() => ({})) as { email?: unknown }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!isPlausibleEmail(email)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  // Scoped to the invoice's own account as well, never just the id.
  const { error } = await supabaseAdmin
    .from('client_customers')
    .update({ email, updated_at: new Date().toISOString() })
    .eq('id', invoice.customer_id)
    .eq('account_id', invoice.account_id)
  if (error) return NextResponse.json({ error: 'Could not save the email. Please try again.' }, { status: 500 })

  return NextResponse.json({ success: true, email })
}
