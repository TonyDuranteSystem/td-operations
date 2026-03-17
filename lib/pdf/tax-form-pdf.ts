/**
 * Tax Form PDF Generator
 *
 * Generates a professional PDF summary from tax form submitted data.
 * Used by:
 * - POST /api/tax-form-completed (automatic after client submission)
 * - Manual backfill for existing submissions
 *
 * Returns a Uint8Array (PDF bytes) ready for Drive upload.
 */

import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from "pdf-lib"

interface TaxFormPDFInput {
  companyName: string
  ein: string
  state: string
  incorporationDate: string
  taxYear: number | string
  submittedAt: string
  submittedData: Record<string, unknown>
  uploadPaths: string[]
}

// Field labels for display
const FIELD_LABELS: Record<string, string> = {
  owner_first_name: "First Name",
  owner_last_name: "Last Name",
  owner_email: "Email",
  owner_phone: "Phone",
  owner_street: "Street Address",
  owner_city: "City",
  owner_state_province: "State / Province",
  owner_zip: "ZIP / Postal Code",
  owner_country: "Country",
  owner_tax_residency: "Tax Residency",
  owner_local_tax_number: "Local Tax ID",
  owner_direct_100_pct: "Direct Owner (100%)",
  owner_ultimate_25_pct: "Ultimate Beneficial Owner (25%+)",
  llc_name: "Company Name",
  ein_number: "EIN",
  state_of_incorporation: "State of Incorporation",
  date_of_incorporation: "Date of Incorporation",
  principal_product_service: "Principal Product / Service",
  us_business_activities: "US Business Activities",
  formation_costs: "Formation Costs ($)",
  bank_contributions: "Bank Contributions ($)",
  distributions_withdrawals: "Distributions / Withdrawals ($)",
  personal_expenses: "Personal Expenses ($)",
  website_url: "Website",
  tax_return_previous_year_filed: "Previous Year Tax Return Filed",
  tax_return_current_year_filed: "Current Year Tax Return Filed",
  additional_members: "Additional Members",
  related_party_transactions: "Related Party Transactions",
}

const SECTIONS = [
  {
    title: "OWNER INFORMATION",
    fields: [
      "owner_first_name", "owner_last_name", "owner_email", "owner_phone",
      "owner_street", "owner_city", "owner_state_province", "owner_zip",
      "owner_country", "owner_tax_residency", "owner_local_tax_number",
      "owner_direct_100_pct", "owner_ultimate_25_pct",
    ],
  },
  {
    title: "COMPANY DETAILS",
    fields: [
      "llc_name", "ein_number", "state_of_incorporation",
      "date_of_incorporation", "website_url",
    ],
  },
  {
    title: "BUSINESS ACTIVITIES",
    fields: ["principal_product_service", "us_business_activities"],
  },
  {
    title: "FINANCIAL INFORMATION",
    fields: [
      "formation_costs", "bank_contributions",
      "distributions_withdrawals", "personal_expenses",
    ],
  },
]

const PAGE_WIDTH = 595.28 // A4
const PAGE_HEIGHT = 841.89
const MARGIN = 50
const LINE_HEIGHT = 15
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

export async function generateTaxFormPDF(input: TaxFormPDFInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  function newPage() {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    y = PAGE_HEIGHT - MARGIN
  }

  function check(needed: number) {
    if (y - needed < MARGIN + 20) newPage()
  }

  // Sanitize text for pdf-lib (WinAnsi encoding can't handle \n, \r, \t, etc.)
  function sanitize(text: string): string {
    return text
      .replace(/\r\n/g, " ")
      .replace(/[\n\r\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }

  function wrapText(text: string, maxW: number, size: number, f: PDFFont): string[] {
    const lines: string[] = []
    const words = text.split(" ")
    let line = ""
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (f.widthOfTextAtSize(test, size) > maxW && line) {
        lines.push(line)
        line = w
      } else {
        line = test
      }
    }
    if (line) lines.push(line)
    return lines
  }

  // ─── Header ───
  page.drawText("TONY DURANTE LLC", {
    x: MARGIN, y, size: 9, font: bold, color: rgb(0.5, 0.5, 0.5),
  })
  y -= 18
  page.drawText("Tax Data Collection Form", {
    x: MARGIN, y, size: 18, font: bold,
  })
  y -= 14
  page.drawText("Submitted Data Summary", {
    x: MARGIN, y, size: 11, font, color: rgb(0.4, 0.4, 0.4),
  })
  y -= 8
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_WIDTH - MARGIN, y },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  })
  y -= 16

  // ─── Company Info ───
  page.drawText(input.companyName, {
    x: MARGIN, y, size: 13, font: bold,
  })
  y -= 14
  page.drawText(
    `EIN: ${input.ein}  |  ${input.state}  |  Inc. ${input.incorporationDate}`,
    { x: MARGIN, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) },
  )
  y -= 12

  const submittedDate = input.submittedAt
    ? new Date(input.submittedAt).toLocaleDateString("en-US", {
        year: "numeric", month: "long", day: "numeric",
      })
    : "N/A"
  page.drawText(`Tax Year: ${input.taxYear}  |  Submitted: ${submittedDate}`, {
    x: MARGIN, y, size: 9, font, color: rgb(0.35, 0.35, 0.35),
  })
  y -= 20

  // ─── Sections ───
  for (const sec of SECTIONS) {
    check(40)

    // Section header with background
    page.drawRectangle({
      x: MARGIN, y: y - 4,
      width: CONTENT_WIDTH, height: 18,
      color: rgb(0.94, 0.94, 0.94),
    })
    page.drawText(sec.title, {
      x: MARGIN + 8, y, size: 9, font: bold, color: rgb(0.2, 0.2, 0.2),
    })
    y -= 22

    for (const key of sec.fields) {
      const label = FIELD_LABELS[key] || key
      let val = input.submittedData[key]

      // Format value
      if (val === undefined || val === null || val === "") {
        val = "---"
      } else if (typeof val === "boolean") {
        val = val ? "Yes" : "No"
      } else if (typeof val === "number") {
        val = "$" + val.toLocaleString("en-US", {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        })
      } else if (Array.isArray(val)) {
        val = JSON.stringify(val, null, 2)
      } else {
        val = String(val)
      }

      check(LINE_HEIGHT * 3)

      // Label
      page.drawText(label, {
        x: MARGIN + 8, y, size: 8, font: bold, color: rgb(0.4, 0.4, 0.4),
      })
      y -= LINE_HEIGHT

      // Value (may wrap)
      const valueStr = sanitize(String(val))
      const lines = wrapText(valueStr, CONTENT_WIDTH - 24, 10, font)
      for (const ln of lines) {
        check(LINE_HEIGHT)
        page.drawText(ln, { x: MARGIN + 16, y, size: 10, font })
        y -= LINE_HEIGHT
      }
      y -= 3
    }
    y -= 10
  }

  // ─── Extra fields not in sections ───
  const sectionFields = new Set(SECTIONS.flatMap((s) => s.fields))
  const extraFields = Object.keys(input.submittedData).filter(
    (k) => !sectionFields.has(k) && input.submittedData[k] !== undefined && input.submittedData[k] !== null && input.submittedData[k] !== "",
  )

  if (extraFields.length > 0) {
    check(40)
    page.drawRectangle({
      x: MARGIN, y: y - 4,
      width: CONTENT_WIDTH, height: 18,
      color: rgb(0.94, 0.94, 0.94),
    })
    page.drawText("ADDITIONAL INFORMATION", {
      x: MARGIN + 8, y, size: 9, font: bold, color: rgb(0.2, 0.2, 0.2),
    })
    y -= 22

    for (const key of extraFields) {
      const label = FIELD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      let val = input.submittedData[key]
      if (typeof val === "boolean") val = val ? "Yes" : "No"
      else if (typeof val === "number") val = "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2 })
      else if (Array.isArray(val)) val = JSON.stringify(val)
      else val = String(val)

      check(LINE_HEIGHT * 2)
      page.drawText(label, {
        x: MARGIN + 8, y, size: 8, font: bold, color: rgb(0.4, 0.4, 0.4),
      })
      y -= LINE_HEIGHT

      const lines = wrapText(sanitize(String(val)), CONTENT_WIDTH - 24, 10, font)
      for (const ln of lines) {
        check(LINE_HEIGHT)
        page.drawText(ln, { x: MARGIN + 16, y, size: 10, font })
        y -= LINE_HEIGHT
      }
      y -= 3
    }
    y -= 10
  }

  // ─── Uploaded Documents ───
  if (input.uploadPaths.length > 0) {
    check(40)
    page.drawRectangle({
      x: MARGIN, y: y - 4,
      width: CONTENT_WIDTH, height: 18,
      color: rgb(0.94, 0.94, 0.94),
    })
    page.drawText("UPLOADED DOCUMENTS", {
      x: MARGIN + 8, y, size: 9, font: bold, color: rgb(0.2, 0.2, 0.2),
    })
    y -= 22

    for (const path of input.uploadPaths) {
      check(LINE_HEIGHT)
      const filename = path.split("/").pop() || path
      page.drawText(`• ${filename}`, {
        x: MARGIN + 16, y, size: 9, font,
      })
      y -= LINE_HEIGHT
    }
  }

  // ─── Footer on all pages ───
  const pages = doc.getPages()
  for (let i = 0; i < pages.length; i++) {
    pages[i].drawText(
      `Tony Durante LLC  |  Confidential  |  Page ${i + 1} of ${pages.length}`,
      { x: MARGIN, y: 25, size: 7, font, color: rgb(0.55, 0.55, 0.55) },
    )
  }

  return doc.save()
}
