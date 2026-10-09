import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { resolveMailingAddress } from '@/lib/addresses'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/invoices/[id] — Full invoice detail with customer + items
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch invoice
  const { data: invoice, error } = await supabaseAdmin
    .from('client_invoices')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
  }

  // Access control — default-deny (handles contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, invoice.account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Fetch customer
  let customer = null
  if (invoice.customer_id) {
    const { data } = await supabaseAdmin
      .from('client_customers')
      .select('name, email, address, vat_number')
      .eq('id', invoice.customer_id)
      .eq('account_id', invoice.account_id) // a customer of another company is never shown on this invoice
      .maybeSingle()
    customer = data
  }

  // Fetch line items
  const { data: items } = await supabaseAdmin
    .from('client_invoice_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('invoice_id', id)
    .order('sort_order')

  // Fetch seller (account) data for the invoice header
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account } = await (supabaseAdmin as any)
    .from('accounts')
    .select('company_name, invoice_logo_url, physical_address, suite_number, ein_number, state_of_formation, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
    .eq('id', invoice.account_id)
    .single()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = account as any
  const sellerAddress = resolveMailingAddress(acct?.mailing_address ?? null, acct?.physical_address ?? null, (acct as any)?.suite_number ?? null)

  const seller = acct ? {
    company_name: acct.company_name ?? null,
    invoice_logo_url: acct.invoice_logo_url ?? null,
    ein_number: acct.ein_number ?? null,
    state_of_formation: acct.state_of_formation ?? null,
    address: sellerAddress,
  } : null

  // Does this company tell its customers how to pay? (a bank account or a payment link) Used for the
  // "no payment details" warning before Send. Counts rows only; the details themselves stay private.
  const [{ count: bankCount }, { count: linkCount }] = await Promise.all([
    supabaseAdmin.from('client_bank_accounts').select('id', { count: 'exact', head: true }).eq('account_id', invoice.account_id),
    supabaseAdmin.from('payment_links').select('id', { count: 'exact', head: true }).eq('account_id', invoice.account_id),
  ])

  return NextResponse.json({
    ...invoice,
    customer,
    payment_setup: { hasBankAccount: (bankCount ?? 0) > 0, hasPaymentLink: (linkCount ?? 0) > 0 },
    items: items ?? [],
    seller,
  })
}
