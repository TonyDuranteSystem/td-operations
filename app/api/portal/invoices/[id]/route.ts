import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
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

  // Access control for client users
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(invoice.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Fetch customer
  let customer = null
  if (invoice.customer_id) {
    const { data } = await supabaseAdmin
      .from('client_customers')
      .select('name, email, address, vat_number')
      .eq('id', invoice.customer_id)
      .single()
    customer = data
  }

  // Fetch line items
  const { data: items } = await supabaseAdmin
    .from('client_invoice_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('invoice_id', id)
    .order('sort_order')

  // Fetch payment methods for unpaid invoices
  let paymentMethods: unknown[] = []
  if (['Sent', 'Overdue'].includes(invoice.status)) {
    const { data: settings } = await supabaseAdmin
      .from('invoice_settings')
      .select('bank_accounts, payment_gateways')
      .limit(1)
      .single()
    if (settings?.bank_accounts) {
      paymentMethods = settings.bank_accounts as unknown[]
    }
  }

  // Fetch seller (account) data for the invoice header
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account } = await (supabaseAdmin as any)
    .from('accounts')
    .select('company_name, invoice_logo_url, physical_address, ein_number, state_of_formation, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
    .eq('id', invoice.account_id)
    .single()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = account as any
  const sellerAddress = resolveMailingAddress(acct?.mailing_address ?? null, acct?.physical_address ?? null)

  const seller = acct ? {
    company_name: acct.company_name ?? null,
    invoice_logo_url: acct.invoice_logo_url ?? null,
    ein_number: acct.ein_number ?? null,
    state_of_formation: acct.state_of_formation ?? null,
    address: sellerAddress,
  } : null

  return NextResponse.json({
    ...invoice,
    customer,
    items: items ?? [],
    payment_methods: paymentMethods,
    seller,
  })
}
