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

import { PDFDocument, rgb, type PDFFont } from 'pdf-lib'
import { embedUnicodeFonts } from '@/lib/pdf/unicode-fonts'
import { wrapPdfText } from '@/lib/pdf/wrap-text'
import { readPngSize, MAX_SIGNATURE_PIXELS } from '@/lib/closure/signature-consent'
import { TD_OFFICE, TD_CITY_STATE_ZIP } from '@/lib/td-address'
import {
  EIN_LETTER_TO,
  EIN_LETTER_REQUEST,
  EIN_LETTER_BODY_CLOSE,
  EIN_LETTER_BODY_QUESTIONS,
  EIN_LETTER_BODY_COPY,
  EIN_LETTER_REPLY_INTRO,
  MAX_ADDRESS_LINES,
  MAX_ADDRESS_LINE_CHARS,
  MAX_COMPANY_NAME_CHARS,
} from '@/lib/closure/ein-letter-wording'

/**
 * Where the IRS is asked to mail its confirmation: OUR Seminole office (Antonio 2026-11-10: "the address for the return letter must be the one in
 * Seminole"). Past letters used the Largo Ulmerton Rd address; that one is now only the company's address for a company that has one of our suites.
 */
export const EIN_LETTER_REPLY_ADDRESS_LINES: readonly string[] = [TD_OFFICE.street, TD_CITY_STATE_ZIP]

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

/** Control characters (a stray carriage return, a form feed, a tab) make the PDF library draw extra lines on top of each other; they are blanks to a person. */
const cleanText = (v: string): string => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()

/** The letter as plain data — the single source of the wording (the PDF draws exactly this). */
export function einClosureLetterLines(i: EinClosureLetterInput): {
  date: string
  fields: Array<{ label: string; lines: string[] }>
  body: string[]
  replyIntro: string
  replyLines: string[]
  signer: string[]
} {
  const body = [EIN_LETTER_BODY_CLOSE, EIN_LETTER_BODY_QUESTIONS]
  if (i.includesEinNotice) body.push(EIN_LETTER_BODY_COPY)
  return {
    date: letterDateText(i.date),
    fields: [
      { label: 'To:', lines: [EIN_LETTER_TO] },
      { label: 'Request:', lines: [EIN_LETTER_REQUEST] },
      { label: 'Name/Business Name:', lines: [cleanText(i.companyName)] },
      { label: 'Mailing Address:', lines: i.companyAddressLines.map(cleanText).filter(Boolean) },
      { label: 'EIN', lines: [cleanText(i.ein)] },
    ],
    body,
    replyIntro: EIN_LETTER_REPLY_INTRO,
    replyLines: [...EIN_LETTER_REPLY_ADDRESS_LINES],
    signer: [`Name: ${cleanText(i.signerName)}`, `Phone: ${EIN_LETTER_CONTACT.phone}`, `Email: ${EIN_LETTER_CONTACT.email}`],
  }
}

export { MAX_ADDRESS_LINES, MAX_ADDRESS_LINE_CHARS, MAX_COMPANY_NAME_CHARS }

/** Right-to-left scripts need shaping the PDF font does not do — the letters would print in the wrong order. */
const RTL_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

/** What the caller must fix before a letter can be made (empty = fine). Plain sentences, shown to staff. */
export function einClosureLetterProblems(i: Pick<EinClosureLetterInput, 'companyName' | 'ein' | 'companyAddressLines' | 'signerName'>): string[] {
  const out: string[] = []
  const address = i.companyAddressLines.map(cleanText).filter(Boolean)
  if (!cleanText(i.companyName)) out.push("The company's legal name is missing.")
  if (cleanText(i.companyName).length > MAX_COMPANY_NAME_CHARS) out.push(`The company name is longer than ${MAX_COMPANY_NAME_CHARS} characters — check it.`)
  if (!/^\d{2}-?\d{7}$/.test(cleanText(i.ein))) out.push('The EIN must be 9 digits (XX-XXXXXXX).')
  if (address.length === 0) out.push("The company's address is missing — the IRS asks for it (copy it from the EIN letter).")
  if (address.length > MAX_ADDRESS_LINES) out.push(`The address has ${address.length} lines — the letter has room for ${MAX_ADDRESS_LINES}. Join some lines (for example the street and the suite) and make it again.`)
  if (address.some((l) => l.length > MAX_ADDRESS_LINE_CHARS)) out.push(`An address line is longer than ${MAX_ADDRESS_LINE_CHARS} characters — split it over two lines.`)
  if (!cleanText(i.signerName)) out.push("The signer's name is missing.")
  if ([i.companyName, i.signerName, ...address].some((t) => RTL_SCRIPT.test(t))) out.push('The letter cannot print right-to-left writing (Arabic, Hebrew) in the right order — write the name and address in Latin letters.')
  return out
}

export const PAGE_W = 612
const PAGE_H = 792
export const MARGIN = 72
const LABEL_X = MARGIN
const VALUE_X = 230
/** The room the answer column has: from the value column to the right margin. A longer value WRAPS inside it (it used to run off the page). */
const VALUE_W = PAGE_W - MARGIN - VALUE_X
const BASE_SIZE = 11.5
const BASE_LEAD = 16
/** The lowest a line of text may sit (the page's bottom margin). */
export const MIN_BASELINE = 54
/** Tried in order: normal size first, then a little smaller until the whole letter fits ONE page (a long address must never push the signature off it). */
const FIT_SCALES = [1, 0.93, 0.86, 0.8]
const BLACK = rgb(0, 0, 0)

export type Op =
  | { t: 'text'; x: number; y: number; text: string; bold: boolean; size: number }
  | { t: 'sig'; x: number; y: number; h: number }

export interface Fonts {
  regular: PDFFont
  bold: PDFFont
}

/** Where every line of the letter goes at one size: the page is planned first, drawn second, so a letter that does not fit is never half-drawn. */
export function planLetter(lines: ReturnType<typeof einClosureLetterLines>, f: Fonts, k: number): { ops: Op[]; lastBaseline: number } {
  const size = BASE_SIZE * k
  const lead = BASE_LEAD * k
  const ops: Op[] = []
  let y = PAGE_H - MARGIN

  // "Date: 11/04/2026", right-aligned: the label bold, the date regular
  const dateValue = ` ${lines.date}`
  const dateValueW = f.regular.widthOfTextAtSize(dateValue, size)
  ops.push({ t: 'text', x: PAGE_W - MARGIN - f.bold.widthOfTextAtSize('Date:', size) - dateValueW, y, text: 'Date:', bold: true, size })
  ops.push({ t: 'text', x: PAGE_W - MARGIN - dateValueW, y, text: dateValue, bold: false, size })
  y -= lead * 3

  for (const field of lines.fields) {
    ops.push({ t: 'text', x: LABEL_X, y, text: field.label, bold: true, size })
    const isEin = field.label === 'EIN'
    const valueSize = isEin ? size + 1.5 * k : size
    const valueFont = isEin ? f.bold : f.regular
    const rows = field.lines.flatMap((l) => wrapPdfText(l, valueFont, valueSize, VALUE_W))
    rows.forEach((row, n) => {
      ops.push({ t: 'text', x: VALUE_X, y, text: row, bold: isEin, size: valueSize })
      if (n < rows.length - 1) y -= lead
    })
    y -= lead * 2
  }

  const paragraphs = (texts: string[]) => {
    for (const p of texts) {
      for (const row of wrapPdfText(p, f.regular, size, PAGE_W - MARGIN * 2)) {
        ops.push({ t: 'text', x: MARGIN, y, text: row, bold: false, size })
        y -= lead
      }
      y -= lead * 0.4
    }
  }
  paragraphs(lines.body)
  y -= lead * 0.5
  paragraphs([lines.replyIntro])
  for (const l of lines.replyLines) {
    ops.push({ t: 'text', x: MARGIN, y, text: l, bold: false, size })
    y -= lead
  }
  y -= lead * 1.2
  ops.push({ t: 'text', x: MARGIN, y, text: 'Thank you,', bold: false, size })
  y -= 8 * k

  const sigH = 48 * k
  ops.push({ t: 'sig', x: MARGIN, y, h: sigH })
  y -= sigH + 6 * k
  let lastBaseline = y
  for (const l of lines.signer) {
    ops.push({ t: 'text', x: MARGIN, y, text: l, bold: false, size })
    lastBaseline = y
    y -= lead
  }
  return { ops, lastBaseline }
}

/** Characters the letter's font has no picture for (they would print as empty boxes, silently). */
function unprintableChars(texts: string[], fonts: PDFFont[]): string[] {
  const sets = fonts.map((font) => new Set(font.getCharacterSet()))
  const bad = new Set<string>()
  for (const t of texts) {
    for (const ch of t) {
      const cp = ch.codePointAt(0) as number
      if (cp < 32) continue
      if (!sets.every((set) => set.has(cp))) bad.add(ch)
    }
  }
  return Array.from(bad)
}

export interface EinClosureLetterResult {
  bytes: Uint8Array
  /** the client's drawing is on the letter (false = a line to sign by hand, even when a drawing was handed in but could not be used) */
  signatureUsed: boolean
  /** plain sentences for staff */
  warnings: string[]
}

/** The PDF of the letter (US Letter, one page; the copy of the EIN notice is merged behind it by the caller). */
export async function buildEinClosureLetter(i: EinClosureLetterInput): Promise<EinClosureLetterResult> {
  const problems = einClosureLetterProblems(i)
  if (problems.length > 0) throw new Error(problems.join(' '))
  const lines = einClosureLetterLines(i)
  const warnings: string[] = []

  const pdf = await PDFDocument.create()
  pdf.setTitle(`EIN closure letter — ${cleanText(i.companyName)}`)
  const fonts = await embedUnicodeFonts(pdf)

  const bad = unprintableChars([...lines.fields.flatMap((f) => f.lines), ...lines.signer], [fonts.regular, fonts.bold])
  if (bad.length > 0) throw new Error(`The letter cannot print these characters: ${bad.map((c) => `"${c}"`).join(' ')} — retype them with plain letters (they would show as empty boxes).`)

  let plan: ReturnType<typeof planLetter> | null = null
  for (const k of FIT_SCALES) {
    const tryPlan = planLetter(lines, fonts, k)
    if (tryPlan.lastBaseline >= MIN_BASELINE) { plan = tryPlan; break }
  }
  if (!plan) throw new Error('The company name and address are too long to fit the letter on one page — shorten them.')

  // the client's drawing: only a readable PNG of a sensible size; anything else leaves the line to sign by hand and says so
  let png: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null
  if (i.signaturePng && i.signaturePng.length > 0) {
    const dims = readPngSize(i.signaturePng)
    if (!dims || dims.width > MAX_SIGNATURE_PIXELS || dims.height > MAX_SIGNATURE_PIXELS) {
      warnings.push("The client's signature picture is not a usable size, so the letter has a line to sign by hand.")
    } else {
      try {
        png = await pdf.embedPng(i.signaturePng)
      } catch (e) {
        warnings.push(`The client's signature picture could not be read (${e instanceof Error ? e.message : String(e)}), so the letter has a line to sign by hand.`)
      }
    }
  }

  const page = pdf.addPage([PAGE_W, PAGE_H])
  for (const op of plan.ops) {
    if (op.t === 'text') {
      page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: op.bold ? fonts.bold : fonts.regular, color: BLACK })
    } else if (png) {
      const scale = Math.min(op.h / png.height, 190 / png.width)
      page.drawImage(png, { x: op.x, y: op.y - png.height * scale, width: png.width * scale, height: png.height * scale })
    } else {
      page.drawLine({ start: { x: op.x, y: op.y - op.h + 8 }, end: { x: op.x + 190, y: op.y - op.h + 8 }, thickness: 0.8, color: BLACK })
    }
  }
  return { bytes: await pdf.save(), signatureUsed: !!png, warnings }
}

/** Same letter, bytes only. */
export async function buildEinClosureLetterPdf(i: EinClosureLetterInput): Promise<Uint8Array> {
  return (await buildEinClosureLetter(i)).bytes
}
