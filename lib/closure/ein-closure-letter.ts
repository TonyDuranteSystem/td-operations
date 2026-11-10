/**
 * The EIN closure letter — the one-page letter we send the IRS to close a company's business account (Company Closure, dev job a6bbea09).
 *
 * The IRS has NO official form or prescribed format for this (irs.gov "Closing a business" and "If you no longer need your EIN",
 * checked 2026-11-10): the letter needs the complete legal name, the EIN, the business address and the reason, and a copy of the EIN
 * assignment notice goes with it when there is one. So this is OUR letter, and it is the SAME wording every closure letter in production
 * already used (Dynamiq SR 2023, Terra Prime 2026-09, MaoBao 2026, Italyflow 2026-11-04) — word for word, so the IRS keeps seeing one letter.
 *
 * Pure: no database, no network. `buildEinClosureLetterPdf` draws the page; `einClosureLetterLines` is the same text as data so the
 * wording is pinned by tests without parsing a PDF. The caller (lib/closure/ein-closure-package.ts) gathers the facts, attaches the copy
 * of the EIN notice and saves the result.
 *
 * The signature: when the client drew one in the closure wizard its PNG goes above their name; with none, the letter carries a blank
 * line to sign by hand (the three closures that started before the wizard had the box are signed that way). A signature is NEVER taken
 * from anywhere else (a passport photo is not a signature on this letter).
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { embedUnicodeFonts } from '@/lib/pdf/unicode-fonts'
import { wrapPdfText } from '@/lib/pdf/wrap-text'
import { TD_LARGO_STREET_3D, TD_LARGO_CITY, TD_LARGO_STATE, TD_LARGO_ZIP } from '@/lib/addresses'

/** Where the IRS is asked to mail its confirmation: our official Largo address (the company's mail goes there — same as every past letter). */
export const EIN_LETTER_REPLY_ADDRESS_LINES: readonly string[] = [TD_LARGO_STREET_3D, `${TD_LARGO_CITY}, ${TD_LARGO_STATE} ${TD_LARGO_ZIP}`]

/** The contact lines every past letter carries under the signer's name (TD's phone and support mailbox). */
export const EIN_LETTER_CONTACT = { phone: '727-452-1093', email: 'support@tonydurante.us' } as const

export interface EinClosureLetterInput {
  /** The company's complete legal name, as the client wrote it. */
  companyName: string
  /** The EIN as written on the notice (XX-XXXXXXX). */
  ein: string
  /** The company's address on file with the IRS — one entry per line. Required: the IRS wants it. */
  companyAddressLines: string[]
  /** The owner who signs (the client). */
  signerName: string
  /** The date printed top right. */
  date: Date
  /** A copy of the EIN assignment notice follows the letter (adds the sentence "I have included a copy…"). */
  includesEinNotice: boolean
  /** The client's drawn signature (PNG bytes) — omitted = a blank line to sign by hand. */
  signaturePng?: Uint8Array | null
}

/** "11/04/2026" — the US way, in New York time (the letter goes to a US agency; a UTC date after 8 pm ET would be tomorrow's). */
export function letterDateText(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('month')}/${get('day')}/${get('year')}`
}

/** The letter as plain data — the single source of the wording (the PDF draws exactly this). */
export function einClosureLetterLines(i: EinClosureLetterInput): {
  date: string
  fields: Array<{ label: string; lines: string[] }>
  body: string[]
  replyIntro: string
  replyLines: string[]
  signer: string[]
} {
  const body = [
    'Please close the business account associated with the EIN listed above. I am no longer using this account.',
    'Please let me know if you have any questions or need anything else.',
  ]
  if (i.includesEinNotice) body.push('I have included a copy of the original EIN Assignment /Confirmation Letter.')
  return {
    date: letterDateText(i.date),
    fields: [
      { label: 'To:', lines: ['Internal Revenue Service'] },
      { label: 'Request:', lines: ['Close Business Account/Cancel EIN'] },
      { label: 'Name/Business Name:', lines: [i.companyName.trim()] },
      { label: 'Mailing Address:', lines: i.companyAddressLines.map((l) => l.trim()).filter(Boolean) },
      { label: 'EIN', lines: [i.ein.trim()] },
    ],
    body,
    replyIntro: 'Please mail a confirmation letter to the address listed below.',
    replyLines: [...EIN_LETTER_REPLY_ADDRESS_LINES],
    signer: [`Name: ${i.signerName.trim()}`, `Phone: ${EIN_LETTER_CONTACT.phone}`, `Email: ${EIN_LETTER_CONTACT.email}`],
  }
}

/** What the caller must fix before a letter can be made (empty = fine). Plain sentences, shown to staff. */
export function einClosureLetterProblems(i: Pick<EinClosureLetterInput, 'companyName' | 'ein' | 'companyAddressLines' | 'signerName'>): string[] {
  const out: string[] = []
  if (!i.companyName.trim()) out.push("The company's legal name is missing.")
  if (!/^\d{2}-?\d{7}$/.test(i.ein.trim())) out.push('The EIN must be 9 digits (XX-XXXXXXX).')
  if (i.companyAddressLines.map((l) => l.trim()).filter(Boolean).length === 0) out.push("The company's address is missing — the IRS asks for it (copy it from the EIN letter).")
  if (!i.signerName.trim()) out.push("The signer's name is missing.")
  return out
}

const PAGE_W = 612
const PAGE_H = 792
const MARGIN = 72
const LABEL_X = MARGIN
const VALUE_X = 230
const SIZE = 11.5
const LEAD = 16
const BLACK = rgb(0, 0, 0)

/** The PDF of the letter (US Letter, one page; the copy of the EIN notice is merged behind it by the caller). */
export async function buildEinClosureLetterPdf(i: EinClosureLetterInput): Promise<Uint8Array> {
  const problems = einClosureLetterProblems(i)
  if (problems.length > 0) throw new Error(problems.join(' '))
  const lines = einClosureLetterLines(i)

  const pdf = await PDFDocument.create()
  pdf.setTitle(`EIN closure letter — ${i.companyName.trim()}`)
  const { regular, bold } = await embedUnicodeFonts(pdf)
  const page = pdf.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  // "Date: 11/04/2026", right-aligned: the label bold, the date regular
  const dateValue = ` ${lines.date}`
  const dateValueW = regular.widthOfTextAtSize(dateValue, SIZE)
  page.drawText('Date:', { x: PAGE_W - MARGIN - bold.widthOfTextAtSize('Date:', SIZE) - dateValueW, y, size: SIZE, font: bold, color: BLACK })
  page.drawText(dateValue, { x: PAGE_W - MARGIN - dateValueW, y, size: SIZE, font: regular, color: BLACK })
  y -= LEAD * 3

  for (const f of lines.fields) {
    page.drawText(f.label, { x: LABEL_X, y, size: SIZE, font: bold, color: BLACK })
    const isEin = f.label === 'EIN'
    for (let k = 0; k < f.lines.length; k++) {
      page.drawText(f.lines[k], { x: VALUE_X, y, size: isEin ? SIZE + 1.5 : SIZE, font: isEin ? bold : regular, color: BLACK })
      if (k < f.lines.length - 1) y -= LEAD
    }
    y -= LEAD * 2
  }

  y = drawParagraphs(page, regular, lines.body, y)
  y -= LEAD * 0.5
  y = drawParagraphs(page, regular, [lines.replyIntro], y)
  for (const l of lines.replyLines) {
    page.drawText(l, { x: MARGIN, y, size: SIZE, font: regular, color: BLACK })
    y -= LEAD
  }
  y -= LEAD * 1.2
  page.drawText('Thank you,', { x: MARGIN, y, size: SIZE, font: regular, color: BLACK })
  y -= 8

  // the signature: the client's drawn PNG, or a blank line to sign by hand
  const SIG_H = 48
  if (i.signaturePng && i.signaturePng.length > 0) {
    const png = await pdf.embedPng(i.signaturePng)
    const scale = Math.min(SIG_H / png.height, 190 / png.width)
    page.drawImage(png, { x: MARGIN, y: y - png.height * scale, width: png.width * scale, height: png.height * scale })
  } else {
    page.drawLine({ start: { x: MARGIN, y: y - SIG_H + 8 }, end: { x: MARGIN + 190, y: y - SIG_H + 8 }, thickness: 0.8, color: BLACK })
  }
  y -= SIG_H + 6
  for (const l of lines.signer) {
    page.drawText(l, { x: MARGIN, y, size: SIZE, font: regular, color: BLACK })
    y -= LEAD
  }
  return pdf.save()
}

function drawParagraphs(page: PDFPage, font: PDFFont, paragraphs: string[], startY: number): number {
  let y = startY
  const maxW = PAGE_W - MARGIN * 2
  for (const p of paragraphs) {
    for (const line of wrapPdfText(p, font, SIZE, maxW)) {
      page.drawText(line, { x: MARGIN, y, size: SIZE, font, color: BLACK })
      y -= LEAD
    }
    y -= LEAD * 0.4
  }
  return y
}
