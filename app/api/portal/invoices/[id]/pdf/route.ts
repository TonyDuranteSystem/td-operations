import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

/**
 * GET /api/portal/invoices/[id]/pdf — Generate and stream invoice PDF
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

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(invoice.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  const { data: customer } = invoice.customer_id
    ? await supabaseAdmin.from('client_customers').select('name, email, address, vat_number').eq('id', invoice.customer_id).single()
    : { data: null }

  const { data: items } = await supabaseAdmin
    .from('client_invoice_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('invoice_id', id)
    .order('sort_order')

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name, invoice_logo_url')
    .eq('id', invoice.account_id)
    .single()

  // Generate PDF
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595, 842]) // A4
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // Embed logo if available
  if (account?.invoice_logo_url) {
    try {
      const logoRes = await fetch(account.invoice_logo_url)
      if (logoRes.ok) {
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer())
        const contentType = logoRes.headers.get('content-type') || ''
        const logoImage = contentType.includes('png')
          ? await pdfDoc.embedPng(logoBytes)
          : await pdfDoc.embedJpg(logoBytes)
        const logoScale = logoImage.scaleToFit(80, 50)
        page.drawImage(logoImage, { x: 460, y: 775, width: logoScale.width, height: logoScale.height })
      }
    } catch {
      // Logo embed failed silently — continue without it
    }
  }

  const blue = rgb(0.15, 0.39, 0.92) // #2563eb
  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)
  const lightGray = rgb(0.92, 0.92, 0.92)

  const sym = invoice.currency === 'EUR' ? 'EUR' : 'USD'
  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'

  let y = 790

  // Header — Company name
  page.drawText(account?.company_name ?? 'Invoice', {
    x: 50, y, size: 20, font: helveticaBold, color: blue,
  })

  // Invoice number + status — right side
  page.drawText(`INVOICE`, {
    x: 430, y: y + 2, size: 12, font: helveticaBold, color: gray,
  })
  y -= 24
  page.drawText(invoice.invoice_number, {
    x: 430, y, size: 14, font: helveticaBold, color: black,
  })
  y -= 16
  page.drawText(`Status: ${invoice.status}`, {
    x: 430, y, size: 9, font: helvetica, color: gray,
  })

  // Dates
  y -= 10
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: lightGray })
  y -= 25

  page.drawText('Issue Date:', { x: 50, y, size: 9, font: helvetica, color: gray })
  page.drawText(invoice.issue_date ?? '—', { x: 120, y, size: 9, font: helveticaBold, color: black })

  page.drawText('Due Date:', { x: 250, y, size: 9, font: helvetica, color: gray })
  page.drawText(invoice.due_date ?? '—', { x: 310, y, size: 9, font: helveticaBold, color: black })

  page.drawText('Currency:', { x: 430, y, size: 9, font: helvetica, color: gray })
  page.drawText(sym, { x: 485, y, size: 9, font: helveticaBold, color: black })

  // Bill To
  y -= 35
  page.drawText('BILL TO', { x: 50, y, size: 9, font: helveticaBold, color: gray })
  y -= 16
  if (customer) {
    page.drawText(customer.name, { x: 50, y, size: 11, font: helveticaBold, color: black })
    y -= 14
    if (customer.email) { page.drawText(customer.email, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }
    if (customer.address) { page.drawText(customer.address, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }
    if (customer.vat_number) { page.drawText(`VAT: ${customer.vat_number}`, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }
  }

  // Table header
  y -= 20
  page.drawRectangle({ x: 50, y: y - 4, width: 495, height: 20, color: rgb(0.96, 0.96, 0.98) })
  page.drawText('Description', { x: 55, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Qty', { x: 340, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Price', { x: 400, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Amount', { x: 480, y, size: 8, font: helveticaBold, color: gray })

  // Table rows
  y -= 22
  for (const item of (items ?? [])) {
    // Truncate long descriptions
    const desc = item.description.length > 55 ? item.description.slice(0, 55) + '...' : item.description
    page.drawText(desc, { x: 55, y, size: 9, font: helvetica, color: black })
    page.drawText(String(item.quantity), { x: 345, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${item.unit_price.toFixed(2)}`, { x: 395, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${item.amount.toFixed(2)}`, { x: 475, y, size: 9, font: helveticaBold, color: black })
    y -= 18
    page.drawLine({ start: { x: 50, y: y + 6 }, end: { x: 545, y: y + 6 }, thickness: 0.3, color: lightGray })
  }

  // Totals
  y -= 15
  page.drawText('Subtotal', { x: 400, y, size: 9, font: helvetica, color: gray })
  page.drawText(`${csym}${invoice.subtotal.toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: black })

  if (invoice.discount > 0) {
    y -= 16
    page.drawText('Discount', { x: 400, y, size: 9, font: helvetica, color: gray })
    page.drawText(`-${csym}${invoice.discount.toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: rgb(0.8, 0.2, 0.2) })
  }

  y -= 20
  page.drawLine({ start: { x: 395, y: y + 8 }, end: { x: 545, y: y + 8 }, thickness: 1, color: blue })
  page.drawText('TOTAL', { x: 400, y, size: 11, font: helveticaBold, color: blue })
  page.drawText(`${csym}${invoice.total.toFixed(2)}`, { x: 470, y, size: 11, font: helveticaBold, color: blue })

  // Message / payment terms
  if (invoice.message) {
    y -= 40
    page.drawText('Payment Terms', { x: 50, y, size: 9, font: helveticaBold, color: gray })
    y -= 14
    // Simple word wrap
    const words = invoice.message.split(' ')
    let line = ''
    for (const word of words) {
      const test = line ? `${line} ${word}` : word
      if (helvetica.widthOfTextAtSize(test, 9) > 490) {
        page.drawText(line, { x: 50, y, size: 9, font: helvetica, color: black })
        y -= 13
        line = word
      } else {
        line = test
      }
    }
    if (line) page.drawText(line, { x: 50, y, size: 9, font: helvetica, color: black })
  }

  // Footer
  page.drawText(`Generated by TD Portal`, {
    x: 50, y: 30, size: 7, font: helvetica, color: rgb(0.7, 0.7, 0.7),
  })

  // Serialize
  const pdfBytes = await pdfDoc.save()

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
    },
  })
}
