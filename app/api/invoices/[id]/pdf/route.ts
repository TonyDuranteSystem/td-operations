import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'
import { resolveMailingAddress } from '@/lib/addresses'
import { resolveBankDetails } from '@/lib/invoice-auto-send'
import { resolveInvoiceAudience, sanitizeInvoiceMessage, gateBankDetailsForAudience } from '@/lib/portal/pay-token'

import { TD_COMPANY } from '@/lib/config'

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
    .select('company_name, physical_address, ein_number, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
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
  const currency: 'USD' | 'EUR' = payment.amount_currency === 'EUR' ? 'EUR' : 'USD'

  // Audience-gate bank details and the free-text message exactly like the
  // client's own emailed invoice does — this route used to gate only on
  // account.portal_tier === 'active' (missing onboarding/formation) and
  // showed a hardcoded default bank instead of the invoice's real selected
  // one; both fixed by reusing the same canonical helpers the send path
  // already uses (dev jobs 1834af40 / 96e56d06).
  const audience = await resolveInvoiceAudience(
    { account_id: payment.account_id, contact_id: payment.contact_id },
    supabaseAdmin,
  )
  // The ternary below only decides whether to spend a DB read (skip it for
  // portal audience) — it is not the safety boundary. gateBankDetailsForAudience
  // is: even if this condition were ever flipped by mistake, the shared gate
  // still nulls the value for a portal audience (bug-hunter finding, dev job
  // 96e56d06, 2nd QA round — this was the one call site not routed through it).
  const rawBankDetails = audience === 'no_portal'
    ? await resolveBankDetails(payment.bank_preference, currency)
    : null
  const bankDetails = gateBankDetailsForAudience(rawBankDetails, audience)

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

    message: sanitizeInvoiceMessage(payment.message, audience),
    bankDetails,
  }

  const pdfBytes = await generateInvoicePdf(pdfInput)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${payment.invoice_number ?? 'invoice'}.pdf"`,
    },
  })
}
