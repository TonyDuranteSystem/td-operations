import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isItemHiddenFromUser } from '@/lib/portal/viewer-history'
import { NextRequest, NextResponse } from 'next/server'
import { resolvePdfStatus } from '@/lib/portal/invoice-status'
import { renderInvoicePdf } from '@/lib/portal/invoice-pdf'

/**
 * GET /api/portal/invoices/[id]/pdf — Generate and stream invoice PDF
 * Supports: ?lang=it for Italian labels (auto-detects from contact if omitted)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch invoice + customer + items + account
  const { data: invoice } = await supabaseAdmin
    .from('client_invoices')
    .select('*')
    .eq('id', id)
    .single()

  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // The Send route asks for the PDF as it will look once sent (?as=Sent) so the customer never gets a
  // DRAFT-stamped file. Only a Draft can be shown as Sent; nothing is written to the invoice here.
  const shownStatus = resolvePdfStatus(invoice.status, request.nextUrl.searchParams.get('as'))

  // Access control — default-deny (contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, invoice.account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }
  // A person who joined the company later cannot open an invoice saved before their start date (404, like a missing one).
  if (await isItemHiddenFromUser({ user, accountId: invoice.account_id, kind: 'invoice', itemId: id, createdAt: invoice.created_at })) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const pdfBytes = await renderInvoicePdf({
    invoice,
    shownStatus,
    langParam: request.nextUrl.searchParams.get('lang'),
  })


  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
    },
  })
}
