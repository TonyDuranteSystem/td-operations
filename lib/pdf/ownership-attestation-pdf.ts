/**
 * Attestation of Beneficial Ownership — one-page letter with an ownership chart.
 *
 * Generic on purpose (no bank name, no addressee): the same page works for any
 * bank or provider that asks a company to confirm who owns 25% or more of it.
 * Built from the company's own records by lib/operations/ownership-attestation.ts —
 * nothing on the page is typed by hand.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { embedUnicodeFonts } from '@/lib/pdf/unicode-fonts'
import { wrapPdfText } from '@/lib/pdf/wrap-text'

export interface AttestationOwner {
  fullName: string
  /** Already formatted for the page, e.g. "May 14, 1994". */
  dateOfBirth: string
  nationality: string
  /** 0–100, printed with two decimals. */
  ownershipPct: number
}

export interface OwnershipAttestationInput {
  companyName: string
  /** e.g. "New Mexico, United States" */
  registeredIn: string
  companyAddress: string
  contactEmail?: string | null
  /** Already formatted, e.g. "October 23, 2026". */
  dateLine: string
  /** Every individual holding 25% or more — at most 4. */
  owners: AttestationOwner[]
  signerName: string
  signerPosition: string
}

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 56
const GREEN = rgb(0.30, 0.60, 0.30)
const GREY = rgb(0.4, 0.4, 0.4)
const BLACK = rgb(0, 0, 0)

export function formatPct(pct: number): string {
  return `${pct.toFixed(2)}%`
}

function drawCentered(page: PDFPage, lines: string[], font: PDFFont, size: number, cx: number, topY: number, boxH: number, color = BLACK) {
  const lh = size * 1.3
  let y = topY - boxH / 2 + (lines.length * lh) / 2 - size
  for (const line of lines) {
    const w = font.widthOfTextAtSize(line, size)
    page.drawText(line, { x: cx - w / 2, y, size, font, color })
    y -= lh
  }
}

function box(page: PDFPage, x: number, topY: number, w: number, h: number) {
  page.drawRectangle({ x, y: topY - h, width: w, height: h, borderColor: BLACK, borderWidth: 1 })
}

function line(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: BLACK })
}

/** Where the signer's box sits, as fractions of the page with a TOP-LEFT origin (the e-sign engine's stored form). */
export interface AttestationSignatureField {
  page_index: number
  pos_x: number
  pos_y: number
  width: number
  height: number
}

export interface BuiltOwnershipAttestation {
  bytes: Uint8Array
  signature: AttestationSignatureField
}

export async function generateOwnershipAttestationPDF(input: OwnershipAttestationInput): Promise<Uint8Array> {
  return (await buildOwnershipAttestation(input)).bytes
}

export async function buildOwnershipAttestation(input: OwnershipAttestationInput): Promise<BuiltOwnershipAttestation> {
  if (input.owners.length < 1 || input.owners.length > 4) {
    throw new Error('An attestation needs between 1 and 4 owners.')
  }
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Attestation of Beneficial Ownership - ${input.companyName}`)
  const { regular, bold, oblique } = await embedUnicodeFonts(pdf, { oblique: true })
  const italic = oblique ?? regular
  const page = pdf.addPage([PAGE_W, PAGE_H])
  const contentW = PAGE_W - MARGIN * 2

  // Letterhead band
  const bandH = 78
  page.drawRectangle({ x: MARGIN, y: PAGE_H - 36 - bandH, width: contentW, height: bandH, color: rgb(0.92, 0.92, 0.92) })
  page.drawText(input.companyName, { x: MARGIN + 14, y: PAGE_H - 36 - 30, size: 17, font: bold, color: rgb(0.11, 0.35, 0.27) })
  page.drawText(input.companyAddress, { x: MARGIN + 14, y: PAGE_H - 36 - 48, size: 9.5, font: regular, color: GREY })
  if (input.contactEmail) {
    page.drawText(input.contactEmail, { x: MARGIN + 14, y: PAGE_H - 36 - 62, size: 9.5, font: regular, color: GREY })
  }

  let y = PAGE_H - 36 - bandH - 34
  page.drawText(input.dateLine, { x: MARGIN, y, size: 10.5, font: regular })
  y -= 30

  const intro = `Below we have indicated our ownership structure for ${input.companyName} and highlighted each of our Ultimate Beneficial Owners (individuals with a 25% or more ownership share in the business).`
  for (const l of wrapPdfText(intro, regular, 10.5, contentW)) {
    page.drawText(l, { x: MARGIN, y, size: 10.5, font: regular })
    y -= 14.5
  }
  y -= 14

  const title = `Shareholding Structure Chart of ${input.companyName}`
  const tw = bold.widthOfTextAtSize(title, 11)
  page.drawText(title, { x: PAGE_W / 2 - tw / 2, y, size: 11, font: bold })
  y -= 22

  // Chart: owner boxes in a row, a bus line, then the company box.
  const n = input.owners.length
  const gap = 14
  const boxW = Math.min(180, (contentW - gap * (n - 1)) / n)
  const rowW = boxW * n + gap * (n - 1)
  const startX = PAGE_W / 2 - rowW / 2
  const ownerH = 78
  const ownerTop = y
  const centers: number[] = []
  input.owners.forEach((o, i) => {
    const x = startX + i * (boxW + gap)
    box(page, x, ownerTop, boxW, ownerH)
    const lines: string[] = []
    lines.push(`UBO #${i + 1}: ${o.fullName}`)
    lines.push(`Date of birth: ${o.dateOfBirth}`)
    lines.push(`Nationality: ${o.nationality}`)
    lines.push(`Ownership: ${formatPct(o.ownershipPct)}`)
    const wrapped = lines.flatMap(l => wrapPdfText(l, oblique ? italic : bold, 8.5, boxW - 10))
    drawCentered(page, wrapped, oblique ? italic : bold, 8.5, x + boxW / 2, ownerTop, ownerH, GREEN)
    centers.push(x + boxW / 2)
  })

  const busY = ownerTop - ownerH - 34
  const companyTop = busY - 34
  const companyH = 40
  const companyW = Math.max(rowW, 300)
  const companyX = PAGE_W / 2 - companyW / 2
  // each owner drops to the bus, labelled with the stake
  input.owners.forEach((o, i) => {
    line(page, centers[i], ownerTop - ownerH, centers[i], busY)
    page.drawText(formatPct(o.ownershipPct), { x: centers[i] + 4, y: busY + 12, size: 8.5, font: bold })
  })
  if (n > 1) line(page, centers[0], busY, centers[n - 1], busY)
  const trunkX = n > 1 ? PAGE_W / 2 : centers[0]
  line(page, trunkX, busY, trunkX, companyTop)
  box(page, companyX, companyTop, companyW, companyH)
  drawCentered(page, [input.companyName, `(Registered in ${input.registeredIn})`], bold, 9.5, PAGE_W / 2, companyTop, companyH)

  y = companyTop - companyH - 30
  const confirm = `[I confirm that these natural persons hold or control an interest of 25% or more of ${input.companyName}]`
  for (const l of wrapPdfText(confirm, italic, 10, contentW)) {
    page.drawText(l, { x: MARGIN, y, size: 10, font: italic })
    y -= 14
  }
  y -= 34

  const labelX = MARGIN
  const lineX1 = MARGIN + 150
  const lineX2 = MARGIN + 150 + 220
  const rows: Array<[string, string]> = [
    ['Signed by:', ''],
    ['Name:', input.signerName],
    ['Position:', input.signerPosition],
  ]
  let signature: AttestationSignatureField | null = null
  for (const [label, value] of rows) {
    if (!signature) {
      // the box sits just above the first (blank) line, so the signature lands on it
      const boxH = 26
      signature = {
        page_index: 0,
        pos_x: lineX1 / PAGE_W,
        pos_y: (PAGE_H - (y - 3 + boxH)) / PAGE_H,
        width: (lineX2 - lineX1) / PAGE_W,
        height: boxH / PAGE_H,
      }
    }
    page.drawText(label, { x: labelX, y, size: 10.5, font: bold })
    line(page, lineX1, y - 3, lineX2, y - 3)
    if (value) page.drawText(value, { x: lineX1 + 4, y: y + 1, size: 10.5, font: regular })
    y -= 30
  }

  return { bytes: await pdf.save(), signature: signature as AttestationSignatureField }
}
