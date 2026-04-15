import { PDFDocument, rgb } from 'pdf-lib'
import { embedUnicodeFonts } from './unicode-fonts'

export interface InvoicePdfInput {
  // Header
  companyName: string
  companyAddress?: string | null
  companyState?: string | null
  companyEin?: string | null
  logoUrl?: string | null

  // Document info
  documentType: 'INVOICE' | 'CREDIT NOTE'
  invoiceNumber: string
  status: string
  currency: 'USD' | 'EUR'
  issueDate: string
  dueDate?: string | null

  // Bill to
  billTo: {
    name: string
    email?: string | null
    address?: string | null
    vatNumber?: string | null
  }

  // Line items
  items: Array<{
    description: string
    quantity: number
    unit_price: number
    amount: number
  }>

  // Totals
  subtotal: number
  discount: number
  total: number

  // Payment terms
  message?: string | null

  // Bank details
  bankDetails?: {
    label: string
    accountHolder?: string | null
    bankName?: string | null
    iban?: string | null
    swiftBic?: string | null
    accountNumber?: string | null
    routingNumber?: string | null
  } | null
}

export async function generateInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595, 842]) // A4
  const { regular: helvetica, bold: helveticaBold } = await embedUnicodeFonts(pdfDoc)

  const blue = rgb(0.15, 0.39, 0.92)
  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)
  const lightGray = rgb(0.92, 0.92, 0.92)
  const purple = rgb(0.5, 0.15, 0.7)

  const isCredit = input.documentType === 'CREDIT NOTE'
  const accentColor = isCredit ? purple : blue
  const csym = input.currency === 'EUR' ? '\u20AC' : '$'

  let y = 790
  let companyNameX = 50

  // Logo
  if (input.logoUrl) {
    try {
      const logoRes = await fetch(input.logoUrl)
      if (logoRes.ok) {
        const logoBytes = new Uint8Array(await logoRes.arrayBuffer())
        const contentType = logoRes.headers.get('content-type') || ''
        const logoImage = contentType.includes('png')
          ? await pdfDoc.embedPng(logoBytes)
          : await pdfDoc.embedJpg(logoBytes)
        const logoScale = logoImage.scaleToFit(50, 40)
        page.drawImage(logoImage, { x: 50, y: y - logoScale.height + 20, width: logoScale.width, height: logoScale.height })
        companyNameX = 50 + logoScale.width + 12
      }
    } catch { /* silently skip */ }
  }

  // Company name
  page.drawText(input.companyName, {
    x: companyNameX, y, size: 20, font: helveticaBold, color: accentColor,
  })

  // Company details
  let detailY = y - 16
  if (input.companyAddress) {
    page.drawText(input.companyAddress, { x: companyNameX, y: detailY, size: 8, font: helvetica, color: gray })
    detailY -= 11
  }
  const meta = [
    input.companyState,
    input.companyEin && `EIN: ${input.companyEin}`,
  ].filter(Boolean).join('  |  ')
  if (meta) {
    page.drawText(meta, { x: companyNameX, y: detailY, size: 8, font: helvetica, color: gray })
  }

  // Document type + number — right side
  page.drawText(input.documentType, {
    x: 430, y: y + 2, size: 12, font: helveticaBold, color: gray,
  })
  y -= 24
  page.drawText(input.invoiceNumber, {
    x: 430, y, size: 14, font: helveticaBold, color: black,
  })
  y -= 16
  page.drawText(`Status: ${input.status}`, {
    x: 430, y, size: 9, font: helvetica, color: gray,
  })

  // Separator + Dates
  y -= 10
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: lightGray })
  y -= 25

  page.drawText('Issue Date:', { x: 50, y, size: 9, font: helvetica, color: gray })
  page.drawText(input.issueDate, { x: 120, y, size: 9, font: helveticaBold, color: black })

  if (!isCredit) {
    page.drawText('Due Date:', { x: 250, y, size: 9, font: helvetica, color: gray })
    page.drawText(input.dueDate ?? '—', { x: 310, y, size: 9, font: helveticaBold, color: black })
  }

  page.drawText('Currency:', { x: 430, y, size: 9, font: helvetica, color: gray })
  page.drawText(input.currency, { x: 485, y, size: 9, font: helveticaBold, color: black })

  // Bill To
  y -= 35
  page.drawText('BILL TO', { x: 50, y, size: 9, font: helveticaBold, color: gray })
  y -= 16
  page.drawText(input.billTo.name, { x: 50, y, size: 11, font: helveticaBold, color: black })
  y -= 14
  if (input.billTo.email) { page.drawText(input.billTo.email, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }
  if (input.billTo.address) { page.drawText(input.billTo.address, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }
  if (input.billTo.vatNumber) { page.drawText(`VAT: ${input.billTo.vatNumber}`, { x: 50, y, size: 9, font: helvetica, color: gray }); y -= 13 }

  // Table header
  y -= 20
  page.drawRectangle({ x: 50, y: y - 4, width: 495, height: 20, color: rgb(0.96, 0.96, 0.98) })
  page.drawText('Description', { x: 55, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Qty', { x: 340, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Price', { x: 400, y, size: 8, font: helveticaBold, color: gray })
  page.drawText('Amount', { x: 480, y, size: 8, font: helveticaBold, color: gray })

  // Table rows
  y -= 22
  for (const item of input.items) {
    const desc = item.description.length > 55 ? item.description.slice(0, 55) + '...' : item.description
    page.drawText(desc, { x: 55, y, size: 9, font: helvetica, color: black })
    page.drawText(String(item.quantity), { x: 345, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${Math.abs(item.unit_price).toFixed(2)}`, { x: 395, y, size: 9, font: helvetica, color: black })
    page.drawText(`${csym}${Math.abs(item.amount).toFixed(2)}`, { x: 475, y, size: 9, font: helveticaBold, color: black })
    y -= 18
    page.drawLine({ start: { x: 50, y: y + 6 }, end: { x: 545, y: y + 6 }, thickness: 0.3, color: lightGray })
  }

  // Totals — breathing room from items table (Dante 2026-04-08: "il totale
  // in blu potrebbe scendere più in basso")
  y -= 32
  page.drawText('Subtotal', { x: 400, y, size: 9, font: helvetica, color: gray })
  page.drawText(`${csym}${Math.abs(input.subtotal).toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: black })

  if (input.discount > 0 && !isCredit) {
    y -= 18
    page.drawText('Discount', { x: 400, y, size: 9, font: helvetica, color: gray })
    page.drawText(`-${csym}${input.discount.toFixed(2)}`, { x: 475, y, size: 9, font: helvetica, color: rgb(0.8, 0.2, 0.2) })
  }

  // TOTAL — isolated in a subtle tinted panel so it visually lands lower
  // on the page and separates cleanly from the subtotal.
  y -= 32
  const totalPanelBottom = y - 8
  const totalPanelHeight = 26
  const panelTint = isCredit ? rgb(0.98, 0.96, 1) : rgb(0.94, 0.96, 1)
  page.drawRectangle({ x: 395, y: totalPanelBottom, width: 150, height: totalPanelHeight, color: panelTint })
  page.drawLine({
    start: { x: 395, y: totalPanelBottom + totalPanelHeight },
    end: { x: 545, y: totalPanelBottom + totalPanelHeight },
    thickness: 1.5,
    color: accentColor,
  })
  page.drawText('TOTAL', { x: 405, y, size: 12, font: helveticaBold, color: accentColor })
  const totalStr = isCredit
    ? `-${csym}${Math.abs(input.total).toFixed(2)}`
    : `${csym}${input.total.toFixed(2)}`
  page.drawText(totalStr, { x: 470, y, size: 12, font: helveticaBold, color: accentColor })
  // Drop the following content further down so the total doesn't hug the bank details block.
  y -= 18

  // Message / Payment terms
  if (input.message) {
    y -= 40
    page.drawText('Payment Terms', { x: 50, y, size: 9, font: helveticaBold, color: gray })
    y -= 14
    const words = input.message.split(' ')
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

  // Bank details
  if (input.bankDetails) {
    y -= 30
    page.drawText(`Bank Details — ${input.bankDetails.label}`, { x: 50, y, size: 9, font: helveticaBold, color: gray })
    y -= 14
    const fields = [
      ['Account Holder', input.bankDetails.accountHolder],
      ['Bank', input.bankDetails.bankName],
      ['IBAN', input.bankDetails.iban],
      ['SWIFT/BIC', input.bankDetails.swiftBic],
      ['Account No.', input.bankDetails.accountNumber],
      ['Routing No.', input.bankDetails.routingNumber],
    ]
    for (const [label, value] of fields) {
      if (value) {
        page.drawText(`${label}: ${value}`, { x: 50, y, size: 8, font: helvetica, color: black })
        y -= 12
      }
    }
  }

  // Footer
  page.drawText('Generated by Tony Durante LLC', {
    x: 50, y: 30, size: 7, font: helvetica, color: rgb(0.7, 0.7, 0.7),
  })

  return pdfDoc.save()
}
