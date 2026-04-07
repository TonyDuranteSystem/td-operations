import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'

const TD_COMPANY = {
  name: 'Tony Durante LLC',
  address: '1111 Lincoln Road, Suite 400, Miami Beach, FL 33139',
  state: 'Florida',
  ein: '32-0754285',
}

const BANK_DETAILS: Record<string, InvoicePdfInput['bankDetails']> = {
  USD: {
    label: 'Relay — USD',
    accountHolder: 'Tony Durante LLC',
    bankName: 'Thread Bank',
    accountNumber: '200000306770',
    routingNumber: '064209588',
  },
  EUR: {
    label: 'Banking Circle — EUR',
    bankName: 'Banking Circle S.A.',
    iban: 'DK8989000023658198',
    swiftBic: 'SXPYDKKK',
    accountHolder: 'Tony Durante LLC',
  },
}

/**
 * GET /api/portal/payments/[id]/pdf — Generate TD invoice PDF for portal clients
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch payment
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', id)
    .not('invoice_status', 'is', null)
    .single()

  if (!payment) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Access control — verify this client owns the account
  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(payment.account_id)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Fetch line items + account + contact
  const [itemsResult, accountResult, contactResult] = await Promise.all([
    supabaseAdmin
      .from('payment_items')
      .select('description, quantity, unit_price, amount, sort_order')
      .eq('payment_id', id)
      .order('sort_order'),
    supabaseAdmin
      .from('accounts')
      .select('company_name, physical_address, ein_number')
      .eq('id', payment.account_id)
      .single(),
    supabaseAdmin
      .from('account_contacts')
      .select('contacts(first_name, last_name, email)')
      .eq('account_id', payment.account_id)
      .eq('role', 'Owner')
      .limit(1)
      .maybeSingle(),
  ])

  const account = accountResult.data
  const contact = (contactResult.data as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts
  const isCredit = payment.invoice_status === 'Credit'

  const pdfInput: InvoicePdfInput = {
    companyName: TD_COMPANY.name,
    companyAddress: TD_COMPANY.address,
    companyState: TD_COMPANY.state,
    companyEin: TD_COMPANY.ein,

    documentType: isCredit ? 'CREDIT NOTE' : 'INVOICE',
    invoiceNumber: payment.invoice_number ?? 'DRAFT',
    status: payment.invoice_status,
    currency: payment.amount_currency ?? 'USD',
    issueDate: payment.issue_date ?? new Date().toISOString().split('T')[0],
    dueDate: payment.due_date,

    billTo: {
      name: account?.company_name ?? 'Client',
      email: contact?.email ?? null,
      address: account?.physical_address ?? null,
    },

    items: itemsResult.data ?? [],
    subtotal: Number(payment.subtotal ?? 0),
    discount: Number(payment.discount ?? 0),
    total: Number(payment.total ?? payment.amount ?? 0),

    message: payment.message,
    bankDetails: BANK_DETAILS[payment.amount_currency ?? 'USD'] ?? BANK_DETAILS.USD,
  }

  const pdfBytes = await generateInvoicePdf(pdfInput)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${payment.invoice_number ?? 'invoice'}.pdf"`,
    },
  })
}
