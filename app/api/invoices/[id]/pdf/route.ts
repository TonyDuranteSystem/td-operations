import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'
import { resolveMailingAddress } from '@/lib/addresses'

import { TD_COMPANY } from '@/lib/config'

// Bank details by currency
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
 * GET /api/invoices/[id]/pdf — Generate TD LLC invoice PDF (dashboard auth)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch payment + items + account
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', id)
    .not('invoice_status', 'is', null)
    .single()

  if (!payment) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  const { data: items } = await supabaseAdmin
    .from('payment_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('payment_id', id)
    .order('sort_order')

  const { data: account } = await (supabaseAdmin as any)
    .from('accounts')
    .select('company_name, physical_address, ein_number, portal_tier, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
    .eq('id', payment.account_id)
    .single()

  // Get primary contact for bill-to (via account link, or direct contact_id fallback)
  const [contactLinkResult, directContactResult] = await Promise.all([
    payment.account_id
      ? supabaseAdmin
          .from('account_contacts')
          .select('contacts(first_name, last_name, email)')
          .eq('account_id', payment.account_id)
          .eq('role', 'Owner')
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    !payment.account_id && payment.contact_id
      ? supabaseAdmin
          .from('contacts')
          .select('first_name, last_name, email')
          .eq('id', payment.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const contact = (contactLinkResult.data as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts
    ?? (directContactResult.data as { first_name: string; last_name: string; email: string } | null)

  const isCredit = payment.invoice_status === 'Credit'
  const isPortalClient = account?.portal_tier === 'active'
  const currency = payment.amount_currency ?? 'USD'

  const billToName = account?.company_name
    ?? (contact ? `${contact.first_name} ${contact.last_name}`.trim() : null)
    ?? 'Client'

  const pdfInput: InvoicePdfInput = {
    companyName: TD_COMPANY.name,
    companyAddress: TD_COMPANY.address,
    companyState: TD_COMPANY.state,

    documentType: isCredit ? 'CREDIT NOTE' : 'INVOICE',
    invoiceNumber: payment.invoice_number ?? 'DRAFT',
    status: payment.invoice_status,
    currency,
    issueDate: payment.issue_date ?? new Date().toISOString().split('T')[0],
    dueDate: payment.due_date,

    billTo: {
      name: billToName,
      email: contact?.email ?? null,
      address: resolveMailingAddress((account as any)?.mailing_address, account?.physical_address),
    },

    items: items ?? [],
    subtotal: Number(payment.subtotal ?? 0),
    discount: Number(payment.discount ?? 0),
    total: Number(payment.total ?? payment.amount ?? 0),

    message: payment.message,
    bankDetails: isPortalClient ? null : (BANK_DETAILS[currency] ?? BANK_DETAILS.USD),
  }

  const pdfBytes = await generateInvoicePdf(pdfInput)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${payment.invoice_number ?? 'invoice'}.pdf"`,
    },
  })
}
