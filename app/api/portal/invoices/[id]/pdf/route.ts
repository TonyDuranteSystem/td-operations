import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument, rgb, StandardFonts, degrees } from 'pdf-lib'
import { invoiceLabels, type InvoiceLang } from '@/lib/portal/invoice-labels'

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
    .select('company_name, invoice_logo_url, physical_address, ein_number, state_of_formation')
    .eq('id', invoice.account_id)
    .single()

  // Get default payment link from payment_links table
  const { data: defaultLink } = await supabaseAdmin
    .from('payment_links')
    .select('url, label')
    .eq('account_id', invoice.account_id)
    .eq('is_default', true)
    .maybeSingle()

  const paymentLinkUrl = defaultLink?.url || null

  // --- Language detection ---
  const langParam = request.nextUrl.searchParams.get('lang')
  let lang: InvoiceLang = 'en'
  if (langParam === 'it') {
    lang = 'it'
  } else if (!langParam && invoice.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('language')
      .eq('id', invoice.contact_id)
      .single()
    const rawLang = contact?.language
    if (rawLang === 'Italian' || rawLang === 'it') {
      lang = 'it'
    }
  }
  const L = invoiceLabels[lang]

  // Generate PDF
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595, 842]) // A4
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const blue = rgb(0.15, 0.39, 0.92) // #2563eb
  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)
  const lightGray = rgb(0.92, 0.92, 0.92)

  const sym = invoice.currency === 'EUR' ? 'EUR' : 'USD'
  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'

  let y = 790
  let companyNameX = 50

  // Embed logo if available — top left, before company name
  if (account?.invoice_logo_url) {
    try {
      const logoRes = await fetch(account.invoice_logo_url)
      if (logoRes.ok) {
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer())
        const contentType = logoRes.headers.get('content-type') || ''
        const logoImage = contentType.includes('png')
          ? await pdfDoc.embedPng(logoBytes)
          : await pdfDoc.embedJpg(logoBytes)
        const logoScale = logoImage.scaleToFit(50, 40)
        page.drawImage(logoImage, { x: 50, y: y - logoScale.height + 20, width: logoScale.width, height: logoScale.height })
        companyNameX = 50 + logoScale.width + 12 // Shift company name right of logo
      }
    } catch {
      // Logo embed failed silently — continue without it
    }
  }

  // Header — Company name (to the right of logo if present)
  page.drawText(account?.company_name ?? 'Invoice', {
    x: companyNameX, y, size: 20, font: helveticaBold, color: blue,
  })

  // Company details under company name
  let detailY = y - 16
  if (account?.physical_address) {
    page.drawText(account.physical_address, { x: companyNameX, y: detailY, size: 8, font: helvetica, color: gray })
    detailY -= 11
  }
  const companyMeta = [
    account?.state_of_formation && `${account.state_of_formation}`,
    account?.ein_number && `EIN: ${account.ein_number}`,
  ].filter(Boolean).join('  |  ')
  if (companyMeta) {
    page.drawText(companyMeta, { x: companyNameX, y: detailY, size: 8, font: helvetica, color: gray })
  }

  // Invoice number + status — right side
  page.drawText(L.invoice, {
    x: 430, y: y + 2, size: 12, font: helveticaBold, color: gray,
  })
  y -= 24
  page.drawText(invoice.invoice_number, {
    x: 430, y, size: 14, font: helveticaBold, color: black,
  })
  y -= 16
  page.drawText(`${L.status} ${invoice.status}`, {
    x: 430, y, size: 9, font: helvetica, color: gray,
  })

  // Dates
  y -= 10
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: lightGray })
  y -= 25

  page.drawText(L.issueDate, { x: 50, y, size: 9, font: helvetica, color: gray })
  page.drawText(invoice.issue_date ?? '—', { x: 120, y, size: 9, font: helveticaBold, color: black })

  page.drawText(L.dueDate, { x: 250, y, size: 9, font: helvetica, color: gray })
  page.drawText(invoice.due_date ?? '—', { x: 310, y, size: 9, font: helveticaBold, color: black })

  page.drawText(L.currency, { x: 430, y, size: 9, font: helvetica, color: gray })
  page.drawText(sym, { x: 485, y, size: 9, font: helveticaBold, color: black })

  // Bill To
  y -= 35
  page.drawText(L.billTo, { x: 50, y, size: 9, font: helveticaBold, color: gray })
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
  page.drawText(L.description, { x: 55, y, size: 8, font: helveticaBold, color: gray })
  page.drawText(L.qty, { x: 340, y, size: 8, font: helveticaBold, color: gray })
  page.drawText(L.price, { x: 400, y, size: 8, font: helveticaBold, color: gray })
  page.drawText(L.amount, { x: 480, y, size: 8, font: helveticaBold, color: gray })

  // Table rows (descriptions are NEVER translated)
  y -= 22
  for (const item of (items ?? [])) {
    const desc = item.description.length > 55 ? item.description.slice(0, 55) + '...' : item.description
    page.drawText(desc, { x: 55, y, size: 9, font: helvetica, color: black })
    page.drawText(String(item.quantity), { x: 345, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${(item.unit_price ?? 0).toFixed(2)}`, { x: 395, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${(item.amount ?? 0).toFixed(2)}`, { x: 475, y, size: 9, font: helveticaBold, color: black })
    y -= 18
    page.drawLine({ start: { x: 50, y: y + 6 }, end: { x: 545, y: y + 6 }, thickness: 0.3, color: lightGray })
  }

  // Totals
  y -= 15
  page.drawText(L.subtotal, { x: 400, y, size: 9, font: helvetica, color: gray })
  page.drawText(`${csym}${(invoice.subtotal ?? 0).toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: black })

  if ((invoice.discount ?? 0) > 0) {
    y -= 16
    page.drawText(L.discount, { x: 400, y, size: 9, font: helvetica, color: gray })
    page.drawText(`-${csym}${(invoice.discount ?? 0).toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: rgb(0.8, 0.2, 0.2) })
  }

  y -= 20
  page.drawLine({ start: { x: 395, y: y + 8 }, end: { x: 545, y: y + 8 }, thickness: 1, color: blue })
  page.drawText(L.total, { x: 400, y, size: 11, font: helveticaBold, color: blue })
  page.drawText(`${csym}${(invoice.total ?? 0).toFixed(2)}`, { x: 470, y, size: 11, font: helveticaBold, color: blue })

  // Message / payment terms (message content is NOT translated)
  if (invoice.message) {
    y -= 40
    page.drawText(L.paymentTerms, { x: 50, y, size: 9, font: helveticaBold, color: gray })
    y -= 14
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

  // Bank details — use invoice's selected bank account, fallback to show_on_invoice default
  let bankAccount = null
  if (invoice.bank_account_id) {
    const { data } = await supabaseAdmin
      .from('client_bank_accounts')
      .select('*')
      .eq('id', invoice.bank_account_id)
      .maybeSingle()
    bankAccount = data
  }
  if (!bankAccount) {
    const { data } = await supabaseAdmin
      .from('client_bank_accounts')
      .select('*')
      .eq('account_id', invoice.account_id)
      .eq('show_on_invoice', true)
      .maybeSingle()
    bankAccount = data
  }

  if (bankAccount) {
    y -= 30
    page.drawText(`${L.bankDetails} — ${bankAccount.label}`, { x: 50, y, size: 9, font: helveticaBold, color: gray })
    y -= 14
    // Bank field labels are translated, but values (IBAN, numbers, names) are NOT
    const bankFields: [string, unknown][] = [
      [L.accountHolder, bankAccount.account_holder],
      [L.bank, bankAccount.bank_name],
      [L.iban, bankAccount.iban],
      [L.swiftBic, bankAccount.swift_bic],
      [L.accountNo, bankAccount.account_number],
      [L.routingNo, bankAccount.routing_number],
    ]
    for (const [label, value] of bankFields) {
      if (value) {
        const fullText = `${label}: ${value}`
        if (helvetica.widthOfTextAtSize(fullText, 8) > 490) {
          page.drawText(`${label}:`, { x: 50, y, size: 8, font: helvetica, color: gray })
          y -= 11
          page.drawText(String(value), { x: 50, y, size: 8, font: helvetica, color: black })
          y -= 12
        } else {
          page.drawText(fullText, { x: 50, y, size: 8, font: helvetica, color: black })
          y -= 12
        }
      }
    }
    if (bankAccount.notes) {
      const noteWords = String(bankAccount.notes).split(' ')
      let noteLine = ''
      for (const word of noteWords) {
        const test = noteLine ? `${noteLine} ${word}` : word
        if (helvetica.widthOfTextAtSize(test, 8) > 490) {
          page.drawText(noteLine, { x: 50, y, size: 8, font: helvetica, color: gray })
          y -= 11
          noteLine = word
        } else {
          noteLine = test
        }
      }
      if (noteLine) { page.drawText(noteLine, { x: 50, y, size: 8, font: helvetica, color: gray }); y -= 12 }
    }
  }

  // Payment link
  if (paymentLinkUrl && invoice.status !== 'Paid') {
    y -= 20
    page.drawText(L.payOnline, { x: 50, y, size: 9, font: helveticaBold, color: blue })
    y -= 14
    const maxUrlWidth = 490
    let displayUrl = paymentLinkUrl
    while (displayUrl.length > 10 && helvetica.widthOfTextAtSize(displayUrl, 9) > maxUrlWidth) {
      displayUrl = displayUrl.slice(0, -1)
    }
    if (displayUrl !== paymentLinkUrl) displayUrl += '...'
    page.drawText(displayUrl, { x: 50, y, size: 9, font: helvetica, color: blue })
  }

  // Footer
  page.drawText(L.footer, {
    x: 50, y: 30, size: 7, font: helvetica, color: rgb(0.7, 0.7, 0.7),
  })

  // --- Watermark (after all content, before save) ---
  const watermarks: Record<string, { text: string; color: [number, number, number] }> = {
    Paid:      { text: 'PAID',      color: [0.2, 0.8, 0.2] },
    Draft:     { text: 'DRAFT',     color: [0.7, 0.7, 0.7] },
    Overdue:   { text: 'OVERDUE',   color: [0.9, 0.2, 0.2] },
    Cancelled: { text: 'CANCELLED', color: [0.7, 0.7, 0.7] },
    Partial:   { text: 'PARTIAL',   color: [0.9, 0.6, 0.1] },
  }
  // 'Sent' status = NO watermark (clean invoice for client)
  const wm = watermarks[invoice.status]
  if (wm) {
    const pages = pdfDoc.getPages()
    for (const p of pages) {
      const { width, height } = p.getSize()
      const textWidth = helveticaBold.widthOfTextAtSize(wm.text, 72)
      p.drawText(wm.text, {
        x: width / 2 - textWidth / 2,
        y: height / 2 - 30,
        size: 72,
        font: helveticaBold,
        color: rgb(wm.color[0], wm.color[1], wm.color[2]),
        opacity: 0.12,
        rotate: degrees(45),
      })
    }
  }

  // Serialize
  const pdfBytes = await pdfDoc.save()

  return new NextResponse(Buffer.from(pdfBytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
    },
  })
}
