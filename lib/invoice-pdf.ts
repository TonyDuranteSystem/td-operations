/**
 * Branded PDF Invoice Generator — Tony Durante LLC
 *
 * Uses pdf-lib (pure JS, no native deps) for Vercel serverless compatibility.
 * Professional layout with US flag colors footer and TD branding.
 */

import { PDFDocument, rgb, StandardFonts, PDFPage, PDFFont } from 'pdf-lib'

// ─── Brand Colors (RGB 0-1 range) ───────────────────────────
const COLORS = {
  // US Flag colors
  red: rgb(0.702, 0.098, 0.259),         // #B31942 Old Glory Red
  blue: rgb(0.039, 0.192, 0.380),         // #0A3161 Old Glory Blue
  white: rgb(1, 1, 1),
  // Brand
  tdRed: rgb(0.698, 0.133, 0.204),        // #B22234 TD logo red
  darkGray: rgb(0.176, 0.176, 0.176),     // #2D2D2D
  mediumGray: rgb(0.333, 0.333, 0.333),   // #555555
  lightGray: rgb(0.910, 0.910, 0.910),    // #E8E8E8
  veryLightGray: rgb(0.960, 0.960, 0.960),// #F5F5F5
}

// ─── Company Info ───────────────────────────────────────────
const COMPANY = {
  name: 'Tony Durante LLC',
  tagline: 'Your Way to Freedom',
  address: '10225 Ulmerton Rd Ste 3D',
  cityStateZip: 'Largo, FL 33771',
  phone: '+1 (727) 423-4285',
  email: 'support@tonydurante.us',
  website: 'tonydurante.us',
  certifications: 'IRS Certified Acceptance Agent  •  Public Notary  •  Professional Tax Preparer',
}

// ─── Types ──────────────────────────────────────────────────
export interface InvoiceLineItem {
  description: string
  amount: number
  quantity: number
}

export interface InvoiceData {
  invoiceNumber: string
  date: string           // YYYY-MM-DD
  dueDate: string        // YYYY-MM-DD
  customerName: string
  customerEmail?: string
  customerAddress?: string
  lineItems: InvoiceLineItem[]
  notes?: string
  terms?: string         // e.g. "Net 30"
  memo?: string
}

// ─── Helpers ────────────────────────────────────────────────
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// Helper to draw text right-aligned
function drawRight(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = COLORS.darkGray
) {
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: x - width, y, size, font, color })
}

// Helper to draw centered text
function drawCenter(
  page: PDFPage,
  text: string,
  y: number,
  font: PDFFont,
  size: number,
  color = COLORS.darkGray
) {
  const width = font.widthOfTextAtSize(text, size)
  const pageWidth = page.getWidth()
  page.drawText(text, { x: (pageWidth - width) / 2, y, size, font, color })
}

// ─── Main Generator ─────────────────────────────────────────
export async function generateInvoicePDF(data: InvoiceData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792]) // US Letter

  // Load fonts
  const helvetica = await doc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const helveticaOblique = await doc.embedFont(StandardFonts.HelveticaOblique)

  const { width, height } = page.getSize()
  const margin = 50
  const rightEdge = width - margin
  let y = height - margin

  // ═══════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════

  // Company name (large, red)
  page.drawText('TONY DURANTE', {
    x: margin,
    y: y,
    size: 24,
    font: helveticaBold,
    color: COLORS.tdRed,
  })
  y -= 16

  // Tagline
  page.drawText('Your Way to Freedom', {
    x: margin,
    y: y,
    size: 11,
    font: helveticaOblique,
    color: COLORS.mediumGray,
  })

  // Company details (right side)
  let headerY = height - margin + 2
  const headerLines = [
    { text: COMPANY.name, font: helveticaBold, size: 9 },
    { text: COMPANY.address, font: helvetica, size: 9 },
    { text: COMPANY.cityStateZip, font: helvetica, size: 9 },
    { text: COMPANY.phone, font: helvetica, size: 9 },
    { text: COMPANY.email, font: helvetica, size: 9 },
    { text: COMPANY.website, font: helveticaBold, size: 9 },
  ]

  for (const line of headerLines) {
    drawRight(page, line.text, rightEdge, headerY, line.font, line.size,
      line.text === COMPANY.website ? COLORS.blue : COLORS.mediumGray)
    headerY -= 13
  }

  // Red line under header
  y -= 15
  page.drawRectangle({
    x: margin,
    y: y,
    width: width - margin * 2,
    height: 3,
    color: COLORS.tdRed,
  })

  // ═══════════════════════════════════════════════════════════
  // INVOICE TITLE
  // ═══════════════════════════════════════════════════════════
  y -= 40
  drawCenter(page, 'I N V O I C E', y, helveticaBold, 26, COLORS.blue)

  // ═══════════════════════════════════════════════════════════
  // META SECTION (Bill To + Invoice Details)
  // ═══════════════════════════════════════════════════════════
  y -= 40

  // Bill To
  page.drawText('BILL TO', {
    x: margin,
    y: y,
    size: 8,
    font: helveticaBold,
    color: COLORS.blue,
  })
  y -= 16

  page.drawText(data.customerName, {
    x: margin,
    y: y,
    size: 13,
    font: helveticaBold,
    color: COLORS.darkGray,
  })
  y -= 15

  if (data.customerAddress) {
    page.drawText(data.customerAddress, {
      x: margin,
      y: y,
      size: 10,
      font: helvetica,
      color: COLORS.mediumGray,
    })
    y -= 14
  }

  if (data.customerEmail) {
    page.drawText(data.customerEmail, {
      x: margin,
      y: y,
      size: 10,
      font: helvetica,
      color: COLORS.mediumGray,
    })
    y -= 14
  }

  // Invoice details box (right side)
  const boxWidth = 180
  const boxX = rightEdge - boxWidth
  const boxStartY = y + 60 // Align with Bill To

  // Background
  page.drawRectangle({
    x: boxX,
    y: boxStartY - 75,
    width: boxWidth,
    height: 80,
    color: COLORS.veryLightGray,
    borderColor: COLORS.lightGray,
    borderWidth: 0.5,
  })

  const metaItems = [
    { label: 'Invoice #', value: data.invoiceNumber },
    { label: 'Date', value: formatDate(data.date) },
    { label: 'Due Date', value: formatDate(data.dueDate) },
    ...(data.terms ? [{ label: 'Terms', value: data.terms }] : []),
  ]

  let metaY = boxStartY - 8
  for (const item of metaItems) {
    page.drawText(item.label, {
      x: boxX + 10,
      y: metaY,
      size: 8,
      font: helveticaBold,
      color: COLORS.mediumGray,
    })
    drawRight(page, item.value, boxX + boxWidth - 10, metaY, helveticaBold, 9, COLORS.darkGray)
    metaY -= 16
  }

  // ═══════════════════════════════════════════════════════════
  // LINE ITEMS TABLE
  // ═══════════════════════════════════════════════════════════
  y -= 30

  // Table header
  const tableY = y
  const colDesc = margin + 10
  const colQty = 370
  const colRate = 440
  const colAmount = rightEdge - 10

  // Header background
  page.drawRectangle({
    x: margin,
    y: tableY - 5,
    width: width - margin * 2,
    height: 22,
    color: COLORS.blue,
  })

  page.drawText('DESCRIPTION', { x: colDesc, y: tableY, size: 8, font: helveticaBold, color: COLORS.white })
  drawRight(page, 'QTY', colQty, tableY, helveticaBold, 8, COLORS.white)
  drawRight(page, 'RATE', colRate, tableY, helveticaBold, 8, COLORS.white)
  drawRight(page, 'AMOUNT', colAmount, tableY, helveticaBold, 8, COLORS.white)

  // Line items
  y = tableY - 25
  let subtotal = 0

  for (let i = 0; i < data.lineItems.length; i++) {
    const item = data.lineItems[i]
    const lineTotal = item.amount * item.quantity
    subtotal += lineTotal

    // Alternating row background
    if (i % 2 === 1) {
      page.drawRectangle({
        x: margin,
        y: y - 5,
        width: width - margin * 2,
        height: 20,
        color: COLORS.veryLightGray,
      })
    }

    page.drawText(item.description, { x: colDesc, y: y, size: 10, font: helvetica, color: COLORS.darkGray })
    drawRight(page, String(item.quantity), colQty, y, helvetica, 10, COLORS.darkGray)
    drawRight(page, formatCurrency(item.amount), colRate, y, helvetica, 10, COLORS.darkGray)
    drawRight(page, formatCurrency(lineTotal), colAmount, y, helveticaBold, 10, COLORS.darkGray)

    y -= 22
  }

  // Bottom line of table
  page.drawRectangle({
    x: margin,
    y: y + 12,
    width: width - margin * 2,
    height: 1,
    color: COLORS.lightGray,
  })

  // ═══════════════════════════════════════════════════════════
  // TOTALS
  // ═══════════════════════════════════════════════════════════
  y -= 10

  const totalsX = rightEdge - 200

  // Subtotal
  page.drawText('Subtotal', { x: totalsX, y: y, size: 10, font: helvetica, color: COLORS.mediumGray })
  drawRight(page, formatCurrency(subtotal), colAmount, y, helveticaBold, 10, COLORS.darkGray)
  y -= 20

  // Total Due box
  page.drawRectangle({
    x: totalsX - 10,
    y: y - 6,
    width: rightEdge - totalsX + 20,
    height: 26,
    color: COLORS.blue,
  })

  page.drawText('TOTAL DUE', { x: totalsX, y: y, size: 12, font: helveticaBold, color: COLORS.white })
  drawRight(page, formatCurrency(subtotal), colAmount, y, helveticaBold, 12, COLORS.white)

  // ═══════════════════════════════════════════════════════════
  // NOTES
  // ═══════════════════════════════════════════════════════════
  y -= 45

  if (data.notes || data.memo) {
    const noteText = data.notes || data.memo || ''

    // Left blue accent bar
    page.drawRectangle({
      x: margin,
      y: y - 30,
      width: 3,
      height: 40,
      color: COLORS.blue,
    })

    // Background
    page.drawRectangle({
      x: margin + 3,
      y: y - 30,
      width: width - margin * 2 - 3,
      height: 40,
      color: COLORS.veryLightGray,
    })

    page.drawText('NOTES', {
      x: margin + 12,
      y: y,
      size: 8,
      font: helveticaBold,
      color: COLORS.blue,
    })

    // Split notes into lines
    const noteLines = noteText.split('\n')
    let noteY = y - 14
    for (const line of noteLines) {
      page.drawText(line, {
        x: margin + 12,
        y: noteY,
        size: 9,
        font: helvetica,
        color: COLORS.mediumGray,
      })
      noteY -= 13
    }

    y -= 50
  }

  // ═══════════════════════════════════════════════════════════
  // THANK YOU
  // ═══════════════════════════════════════════════════════════
  y -= 10
  drawCenter(page, 'Thank you for choosing Tony Durante LLC!', y, helveticaOblique, 11, COLORS.mediumGray)

  // ═══════════════════════════════════════════════════════════
  // FOOTER (US Flag Colors)
  // ═══════════════════════════════════════════════════════════
  const footerTop = 80

  // Top stripe: Red | White | Blue
  const stripeWidth = (width) / 3
  const stripeH = 4

  page.drawRectangle({ x: 0, y: footerTop, width: stripeWidth, height: stripeH, color: COLORS.red })
  page.drawRectangle({ x: stripeWidth, y: footerTop, width: stripeWidth, height: stripeH, color: COLORS.white, borderColor: COLORS.lightGray, borderWidth: 0.5 })
  page.drawRectangle({ x: stripeWidth * 2, y: footerTop, width: stripeWidth, height: stripeH, color: COLORS.blue })

  // Certifications
  drawCenter(page, COMPANY.certifications, footerTop - 16, helveticaBold, 7, COLORS.blue)

  // Footer background
  page.drawRectangle({
    x: 0,
    y: 10,
    width: width,
    height: footerTop - 26,
    color: COLORS.veryLightGray,
  })

  // Footer left
  page.drawText(COMPANY.name, { x: margin, y: footerTop - 35, size: 8, font: helveticaBold, color: COLORS.mediumGray })
  page.drawText(`${COMPANY.address}, ${COMPANY.cityStateZip}`, { x: margin, y: footerTop - 47, size: 8, font: helvetica, color: COLORS.mediumGray })

  // Footer right
  drawRight(page, `${COMPANY.phone}  |  ${COMPANY.email}`, rightEdge, footerTop - 35, helvetica, 8, COLORS.mediumGray)
  drawRight(page, COMPANY.website, rightEdge, footerTop - 47, helveticaBold, 8, COLORS.blue)

  // Bottom stripe: Red | White | Blue
  page.drawRectangle({ x: 0, y: 4, width: stripeWidth, height: 5, color: COLORS.red })
  page.drawRectangle({ x: stripeWidth, y: 4, width: stripeWidth, height: 5, color: COLORS.white })
  page.drawRectangle({ x: stripeWidth * 2, y: 4, width: stripeWidth, height: 5, color: COLORS.blue })

  // ═══════════════════════════════════════════════════════════
  // DONE
  // ═══════════════════════════════════════════════════════════
  return doc.save()
}
