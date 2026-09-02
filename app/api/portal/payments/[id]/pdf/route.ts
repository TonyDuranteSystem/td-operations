import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { resolveMailingAddress } from '@/lib/addresses'

import { TD_COMPANY } from '@/lib/config'


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

  // Access control — allow if EITHER (a) client owns the account this invoice
  // belongs to, OR (b) the invoice is contact-scoped (no account_id — a
  // formation-gap client who paid before their company exists) and the
  // contact_id matches the requester. Mirrors the pattern already proven in
  // assertOwnsExpense (app/portal/invoices/expense-actions.ts) and the
  // documents download route. canAccessAccount (not the older
  // getClientAccountIds) also recognizes a Portal Team Access teammate
  // granted the invoices_billing capability — the prior account-only check
  // silently 403'd them too.
  const contactId = getClientContactId(user)
  const hasAccountAccess = await canAccessAccount(user, payment.account_id, 'invoices_billing')
  const hasContactAccess = !payment.account_id && !!contactId && payment.contact_id === contactId
  if (!hasAccountAccess && !hasContactAccess) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Fetch line items + account (if any) + contact. For a contact-scoped
  // payment (no account_id) there is no company to look up — go straight to
  // the contact record instead. Mirrors the identical fallback already
  // shipped on the staff-side sibling route (app/api/invoices/[id]/pdf).
  const [itemsResult, accountResult, contactLinkResult, directContactResult] = await Promise.all([
    supabaseAdmin
      .from('payment_items')
      .select('description, quantity, unit_price, amount, sort_order')
      .eq('payment_id', id)
      .order('sort_order'),
    payment.account_id
      ? (supabaseAdmin as any)
          .from('accounts')
          .select('company_name, physical_address, ein_number, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
          .eq('id', payment.account_id)
          .single()
      : Promise.resolve({ data: null }),
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

  const account = accountResult.data
  const contact = (contactLinkResult.data as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts
    ?? (directContactResult.data as { first_name: string; last_name: string; email: string } | null)
  const isCredit = payment.invoice_status === 'Credit'

  const pdfInput: InvoicePdfInput = {
    companyName: TD_COMPANY.name,
    companyAddress: TD_COMPANY.address,
    companyState: TD_COMPANY.state,

    documentType: isCredit ? 'CREDIT NOTE' : 'INVOICE',
    invoiceNumber: payment.invoice_number ?? 'DRAFT',
    status: payment.invoice_status,
    currency: payment.amount_currency ?? 'USD',
    issueDate: payment.issue_date ?? new Date().toISOString().split('T')[0],
    dueDate: payment.due_date,

    billTo: {
      name: account?.company_name ?? (contact ? `${contact.first_name} ${contact.last_name}`.trim() : null) ?? 'Client',
      email: contact?.email ?? null,
      address: resolveMailingAddress((account as any)?.mailing_address, account?.physical_address),
    },

    items: itemsResult.data ?? [],
    subtotal: Number(payment.subtotal ?? 0),
    discount: Number(payment.discount ?? 0),
    total: Number(payment.total ?? payment.amount ?? 0),

    message: payment.message,
    bankDetails: null,
  }

  const pdfBytes = await generateInvoicePdf(pdfInput)

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${payment.invoice_number ?? 'invoice'}.pdf"`,
    },
  })
}
