/**
 * Bank application intake — a one-file PDF of the applicant's answers, saved next to the documents in
 * CRM Storage. Internal (Business area): it names the partner, unlike the email sent to the recipients.
 * Standard Helvetica only, so any character it cannot draw (other alphabets) becomes "?" instead of
 * crashing the archive; the full original answers always stay in the database.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib"
import { BOFA_TEXT_FIELDS } from "./schema"

const SECTIONS: { title: string; keys: string[] }[] = [
  { title: "Applicant", keys: ["full_name", "email", "phone", "citizenship", "itin", "home_street", "home_city", "home_region", "home_zip", "home_country"] },
  { title: "Company", keys: ["company_name", "ein", "state_of_formation", "company_street", "company_city", "company_region", "company_zip", "company_country", "website"] },
  { title: "The business", keys: ["business_description", "customers", "revenue_model", "monthly_deposits", "first_deposit_source"] },
]

/** Replace characters the standard font cannot encode. */
export function printable(text: string, font: PDFFont): string {
  const allowed = new Set(font.getCharacterSet())
  let out = ""
  for (const ch of text.replace(/\t/g, " ")) {
    const cp = ch.codePointAt(0) as number
    out += cp === 10 || allowed.has(cp) ? ch : "?"
  }
  return out
}

/** Split text into lines no wider than maxWidth (honours existing line breaks). */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split("\n")) {
    let line = ""
    for (const word of para.split(" ")) {
      let w = word
      // a single word wider than the line is broken by characters
      while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
        let cut = w.length - 1
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--
        if (line) { lines.push(line); line = "" }
        lines.push(w.slice(0, cut))
        w = w.slice(cut)
      }
      const test = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(test, size) <= maxWidth) line = test
      else { if (line) lines.push(line); line = w }
    }
    lines.push(line)
  }
  return lines
}

export async function buildSummaryPdf(p: { data: Record<string, string>; partner: string | null; submittedAt: string | null; requestId: string }): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const W = 612, H = 792, M = 50
  let page = pdf.addPage([W, H])
  let y = H - M

  const need = (h: number) => {
    if (y - h < M) { page = pdf.addPage([W, H]); y = H - M }
  }
  const line = (text: string, f: PDFFont, size: number, x = M, color = rgb(0, 0, 0)) => {
    need(size + 4)
    page.drawText(printable(text, f), { x, y: y - size, size, font: f, color })
    y -= size + 4
  }

  line("Bank account application", bold, 18)
  y -= 4
  line(`Submitted: ${p.submittedAt ? p.submittedAt.replace("T", " ").slice(0, 16) + " UTC" : "—"}`, font, 10, M, rgb(0.35, 0.35, 0.35))
  line(`Partner: ${p.partner || "—"}`, font, 10, M, rgb(0.35, 0.35, 0.35))
  line(`Reference: ${p.requestId}`, font, 10, M, rgb(0.35, 0.35, 0.35))
  y -= 8

  const labelW = 150
  for (const sec of SECTIONS) {
    need(40)
    y -= 6
    line(sec.title, bold, 13, M, rgb(0.12, 0.23, 0.37))
    for (const key of sec.keys) {
      const f = BOFA_TEXT_FIELDS.find((x) => x.key === key)
      const value = p.data[key]
      if (!f || !value) continue
      const lines = wrapText(printable(value, font), font, 10, W - M * 2 - labelW)
      need(14 * Math.min(lines.length, 3))
      page.drawText(printable(f.label, bold), { x: M, y: y - 10, size: 9, font: bold, color: rgb(0.25, 0.25, 0.25) })
      for (const l of lines) {
        need(14)
        page.drawText(l, { x: M + labelW, y: y - 10, size: 10, font })
        y -= 13
      }
      y -= 3
    }
  }
  return Buffer.from(await pdf.save())
}
