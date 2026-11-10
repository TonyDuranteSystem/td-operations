/**
 * Form 7004 (Application for Automatic Extension of Time To File Certain Business Income Tax, Information, and Other Returns) —
 * the OFFICIAL IRS form (Rev. December 2025), filled for a foreign-owned single-member LLC (a U.S. disregarded entity) that files Form 5472
 * with a pro forma Form 1120 (Tax Return plan Part 2 item 7, dev job 6f555c9f, 2026-11-09).
 *
 * What the IRS says about this filer (Instructions for Form 5472, "Extension of time to file", irs.gov/instructions/i5472): the entity requests the
 * extension with Form 7004; because the Form 5472 is attached to a pro forma Form 1120, the code for Form 1120 goes on Part I, line 1; the words
 * "Foreign-owned U.S. DE" are written across the top of the form; and the form is faxed or mailed to the filer's fax number / address by the regular
 * due date. The form code for Form 1120 is 12 (the code table printed on the form itself).
 *
 * Template: public/templates/f7004-blank.pdf — the official PDF (https://www.irs.gov/pub/irs-pdf/f7004.pdf, "Form 7004 (Rev. December 2025)",
 * one page) with its XFA layer removed and its still-empty fields flattened, the same method as the SS-4 and 8832 templates (a filled XFA form
 * cannot be read back reliably, so the text is drawn at measured positions). The positions below are the field boxes of the official form.
 * Page size 612 x 792 (US Letter), y = 0 at the bottom.
 *
 * Pure apart from reading the template; nothing is sent anywhere.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { embedUnicodeFonts } from "./unicode-fonts"

/** The code for Form 1120 in the form's own code table (Part I, line 1). */
export const FORM_7004_CODE_FORM_1120 = "12"
/** What the IRS asks to be written across the top of the form for a foreign-owned U.S. disregarded entity. */
export const FORM_7004_TOP_NOTE = "Foreign-owned U.S. DE"

export interface Form7004FillData {
  /** the company's name as it appeared on the prior-year return (the IRS matches the name to its records) */
  companyName: string
  /** employer identification number: "12-3456789" or "123456789" */
  ein: string
  /** "Number and street" */
  street: string
  /** "Room or suite no." (optional) */
  suite?: string
  city: string
  /** two-letter state, or a province for a foreign address */
  state: string
  /** only for a foreign address; a U.S. address leaves it empty */
  country?: string
  zip: string
  /** the calendar year of the return this extension is for (the 7004 line 5a) */
  taxYear: number
  /** lines 6, 7 and 8: the amounts printed in the three boxes. Default "-0-" (the IRS: "enter -0- if zero"). */
  tentativeTax?: string
  totalPayments?: string
  balanceDue?: string
}

/** The boxes of the official form: x, y (lower left) and width, from the form's own fields. */
const BOX = {
  name: { x: 87.4, y: 684.0, w: 358.3 },
  ein: { x: 446.4, y: 684.0, w: 129.6 },
  street: { x: 87.4, y: 660.0, w: 401.5 },
  suite: { x: 489.6, y: 660.0, w: 86.4 },
  city: { x: 87.4, y: 636.0, w: 185.5 },
  state: { x: 274.6, y: 636.0, w: 106.3 },
  country: { x: 382.6, y: 636.0, w: 106.3 },
  zip: { x: 489.6, y: 636.0, w: 86.4 },
  codeDigit1: { x: 547.2, y: 601.0, w: 14.4 },
  codeDigit2: { x: 561.6, y: 601.0, w: 14.4 },
  yearDigits: { x: 223.2, y: 264.0, w: 14.4 },
  line6: { x: 504.0, y: 216.0, w: 72.0 },
  line7: { x: 504.0, y: 192.0, w: 72.0 },
  line8: { x: 504.0, y: 168.0, w: 72.0 },
} as const

const BLACK = rgb(0, 0, 0)
const TEXT_PAD = 3
const BASELINE_RAISE = 4

/** The plain-English reason this data cannot make a valid form, or null when it can. Pure. */
export function form7004Problem(d: Form7004FillData): string | null {
  const name = (d.companyName ?? "").trim()
  if (!name) return "The company name is missing."
  if (!/^\d{2}-?\d{7}$/.test((d.ein ?? "").trim())) return "The EIN must be 9 digits (for example 12-3456789)."
  if (!(d.street ?? "").trim()) return "The street address is missing."
  if (!(d.city ?? "").trim()) return "The city is missing."
  if (!(d.state ?? "").trim()) return "The state is missing."
  if (!(d.zip ?? "").trim()) return "The ZIP code is missing."
  if (!Number.isInteger(d.taxYear) || d.taxYear < 2000 || d.taxYear > 2100) return "The tax year is missing."
  for (const [label, v] of [["Tax", d.tentativeTax], ["Payments", d.totalPayments], ["Balance due", d.balanceDue]] as const) {
    if (v !== undefined && !/^(-0-|\d{1,3}(,\d{3})*(\.\d{2})?|\d+(\.\d{2})?)$/.test(v.trim())) return `${label} must be a dollar amount or -0-.`
  }
  return null
}

/** "123456789" -> "12-3456789"; an already formatted number is returned as is. Pure. */
export function formatEin(ein: string): string {
  const digits = ein.replace(/\D/g, "")
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : ein.trim()
}

async function loadTemplate(): Promise<Buffer> {
  const { existsSync } = await import("fs")
  const { readFile } = await import("fs/promises")
  const { join } = await import("path")
  const templatePath = join(process.cwd(), "public", "templates", "f7004-blank.pdf")
  if (existsSync(templatePath)) return readFile(templatePath)
  // the public file is also served as a static asset: a deployment that does not carry it in the function's files reads it from there
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    "https://app.tonydurante.us"
  const res = await fetch(`${baseUrl}/templates/f7004-blank.pdf`)
  if (!res.ok) throw new Error(`Failed to load the Form 7004 template: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** The biggest font size (max 10) at which `text` fits the box width, never below 6. */
function fitSize(font: PDFFont, text: string, boxWidth: number, max = 10): number {
  const widthAtOne = font.widthOfTextAtSize(text, 1)
  if (!(widthAtOne > 0)) return max
  return Math.max(6, Math.min(max, Math.floor(((boxWidth - TEXT_PAD * 2) / widthAtOne) * 10) / 10))
}

/** Make the filled-in Form 7004 for the data. Throws a plain sentence when the data cannot make a valid form. */
export async function fill7004(data: Form7004FillData): Promise<Uint8Array> {
  const problem = form7004Problem(data)
  if (problem) throw new Error(problem)

  const pdf = await PDFDocument.load(await loadTemplate())
  const { regular: font, bold } = await embedUnicodeFonts(pdf)
  const page: PDFPage = pdf.getPage(0)

  const put = (box: { x: number; y: number; w: number }, text: string | undefined, opts: { right?: boolean; center?: boolean; size?: number; raise?: number } = {}) => {
    const t = (text ?? "").trim()
    if (!t) return
    const size = opts.size ?? fitSize(font, t, box.w)
    const width = font.widthOfTextAtSize(t, size)
    const x = opts.right ? box.x + box.w - TEXT_PAD - width : opts.center ? box.x + (box.w - width) / 2 : box.x + TEXT_PAD
    page.drawText(t, { x, y: box.y + (opts.raise ?? BASELINE_RAISE), size, font, color: BLACK })
  }

  // the words the IRS asks for across the top of the form, in the free margin above the form title
  const top = FORM_7004_TOP_NOTE
  const topSize = 12
  page.drawText(top, { x: (612 - bold.widthOfTextAtSize(top, topSize)) / 2, y: 774, size: topSize, font: bold, color: BLACK })

  put(BOX.name, data.companyName)
  put(BOX.ein, formatEin(data.ein))
  put(BOX.street, data.street)
  put(BOX.suite, data.suite)
  put(BOX.city, data.city)
  put(BOX.state, data.state)
  put(BOX.country, data.country)
  put(BOX.zip, data.zip)

  // Part I, line 1: the form code (Form 1120 = 12), one digit per box
  // (the two code boxes are only 9 pt tall: a small digit sits inside them, not on their top edge)
  put(BOX.codeDigit1, FORM_7004_CODE_FORM_1120.charAt(0), { center: true, size: 7.5, raise: 1.5 })
  put(BOX.codeDigit2, FORM_7004_CODE_FORM_1120.charAt(1), { center: true, size: 7.5, raise: 1.5 })

  // Part II, line 5a: "The application is for calendar year 20__"
  put(BOX.yearDigits, String(data.taxYear).slice(-2), { center: true, size: 9, raise: 3 })

  // lines 6, 7, 8
  put(BOX.line6, data.tentativeTax ?? "-0-", { right: true })
  put(BOX.line7, data.totalPayments ?? "-0-", { right: true })
  put(BOX.line8, data.balanceDue ?? "-0-", { right: true })

  return pdf.save()
}
