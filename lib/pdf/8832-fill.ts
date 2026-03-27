/**
 * Form 8832 (Entity Classification Election) PDF Auto-Fill
 *
 * Used for C-Corp elections: after an LLC gets its EIN, this form
 * must be filed with the IRS to elect classification as a corporation.
 *
 * Template: Templates/IRS Forms/Form-8832-blank.pdf on Google Drive
 * (Drive ID: 10DH6_PsWyczuv2kffmFHYjXys0AWpsJm)
 *
 * The blank PDF has 8 pages. We keep only pages 2-3 (the actual form)
 * and remove page 1 (mailing info), page 4 (late relief), pages 5-8 (instructions).
 *
 * Page size: 612 x 792 (US Letter)
 *
 * COORDINATE MAP (y=0 at bottom, Page 2 = form page 1):
 *
 *   ENTITY NAME  (y≈710): x=75
 *   EIN          (y≈710): x=460
 *   ADDRESS      (y≈680): x=75
 *   CITY/ST/ZIP  (y≈655): x=75
 *   LINE 1a checkbox (Initial classification): x=61, y≈555
 *   LINE 1b checkbox (Change classification):  x=61, y≈540
 *   LINE 3 Yes checkbox: x=61, y≈472
 *   LINE 3 No checkbox:  x=61, y≈458
 *   LINE 4a Owner name:  x=150, y≈430
 *   LINE 4b Owner ID:    x=370, y≈430
 *
 * Page 3 = form page 2:
 *   LINE 6a checkbox (association taxable as corp): x=61, y≈700
 *   LINE 6b checkbox (partnership):                 x=61, y≈688
 *   LINE 6c checkbox (disregarded entity):          x=61, y≈676
 *   LINE 8 Effective date:  x=370, y≈630
 *   LINE 9 Contact person:  x=75, y≈610
 *   LINE 10 Contact phone:  x=420, y≈610
 *   SIGNATURE (y≈555): left blank for e-sig
 *   DATE      (y≈555): x=380
 *   TITLE     (y≈555): x=480
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

// TD LLC Office — used for all client LLC forms
const TD_OFFICE = {
  street: "10225 Ulmerton Rd 3D",
  cityStateZip: "Largo FL 33771",
}

const CONTACT_PERSON = "Antonio Durante"
const CONTACT_PHONE = "3075004873"

export interface Form8832FillData {
  companyName: string
  ein: string
  entityType: "SMLLC" | "MMLLC" | "Corporation"
  memberCount: number
  ownerName: string
  ownerIdNumber?: string // ITIN or blank
  effectiveDate: string // YYYY-MM-DD or MM/DD/YYYY
  ownerTitle: string // "Owner", "Member", "President"
}

/** Format date from YYYY-MM-DD to MM/DD/YYYY (IRS format) */
function formatDate(d: string | undefined): string {
  if (!d) return ""
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d
  const parts = d.split("-")
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`
  return d
}

/** Load the blank Form 8832 template from Google Drive */
async function loadTemplate(): Promise<Buffer> {
  // Try filesystem first (local dev)
  const { existsSync } = await import("fs")
  const { readFile } = await import("fs/promises")
  const { join } = await import("path")

  const templatePath = join(process.cwd(), "public", "templates", "8832-blank.pdf")
  if (existsSync(templatePath)) {
    return readFile(templatePath)
  }

  // Fallback: fetch from app's static assets
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    "https://app.tonydurante.us"
  const res = await fetch(`${baseUrl}/templates/8832-blank.pdf`)
  if (!res.ok) throw new Error(`Failed to load Form 8832 template: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const FONT_SIZE = 10
const CHECK_SIZE = 8

/**
 * Fill Form 8832 by drawing text at coordinates on the flat template.
 * Returns filled PDF as Uint8Array (only 2 pages: form page 1 + page 2).
 */
export async function fill8832(data: Form8832FillData): Promise<Uint8Array> {
  const templateBytes = await loadTemplate()
  const pdf = await PDFDocument.load(templateBytes)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold)
  const black = rgb(0, 0, 0)

  const drawText = (
    page: ReturnType<typeof pdf.getPage>,
    x: number,
    y: number,
    value: string | undefined,
    size = FONT_SIZE
  ) => {
    if (!value) return
    page.drawText(value, { x, y, size, font, color: black })
  }

  const check = (page: ReturnType<typeof pdf.getPage>, x: number, y: number) => {
    page.drawText("X", {
      x: x + 1,
      y: y + 1.5,
      size: CHECK_SIZE,
      font: boldFont,
      color: black,
    })
  }

  // The blank PDF has 8 pages. Actual form is pages 2-3 (index 1, 2).
  // Remove pages in reverse order to avoid index shifting.
  const pageCount = pdf.getPageCount()

  // Remove pages 5-8 (instructions, index 4-7)
  for (let i = pageCount - 1; i >= 4; i--) {
    pdf.removePage(i)
  }
  // Remove page 4 (late relief, index 3)
  pdf.removePage(3)
  // Remove page 1 (mailing address info, index 0)
  pdf.removePage(0)

  // Now we have 2 pages: index 0 = entity info, index 1 = election type + signature
  const page1 = pdf.getPage(0)
  const page2 = pdf.getPage(1)

  // ===== PAGE 1: Entity Information =====

  // Entity name
  drawText(page1, 75, 687, data.companyName)

  // EIN
  drawText(page1, 460, 687, data.ein)

  // Address (TD office)
  drawText(page1, 75, 660, TD_OFFICE.street)

  // City, state, ZIP
  drawText(page1, 75, 640, TD_OFFICE.cityStateZip)

  // Line 1a: Initial classification by newly-formed entity
  check(page1, 61, 555)

  // Line 3: Does the eligible entity have more than one owner?
  if (data.memberCount > 1) {
    // Yes — MMLLC
    check(page1, 61, 472)
  } else {
    // No — SMLLC
    check(page1, 61, 458)
  }

  // Line 4a: Name of owner (only for single-owner entities)
  if (data.memberCount === 1) {
    drawText(page1, 150, 430, data.ownerName)
  }

  // Line 4b: Identifying number of owner (ITIN if available)
  if (data.memberCount === 1 && data.ownerIdNumber) {
    drawText(page1, 370, 430, data.ownerIdNumber)
  }

  // ===== PAGE 2: Election Type + Consent =====

  // Line 6a: A domestic eligible entity electing to be classified as
  // an association taxable as a corporation
  check(page2, 61, 700)

  // Line 8: Election effective date
  drawText(page2, 370, 630, formatDate(data.effectiveDate))

  // Line 9: Contact person
  drawText(page2, 75, 610, CONTACT_PERSON)

  // Line 10: Contact phone
  drawText(page2, 420, 610, CONTACT_PHONE)

  // Consent section — Name + Title (signature left blank for e-sig)
  drawText(page2, 150, 555, `${data.ownerName} - ${data.ownerTitle}`)

  return pdf.save()
}

/**
 * Fill Form 8832 and return as Buffer (convenience wrapper for MCP tools).
 */
export async function generate8832PDF(data: Form8832FillData): Promise<Buffer> {
  const bytes = await fill8832(data)
  return Buffer.from(bytes)
}
