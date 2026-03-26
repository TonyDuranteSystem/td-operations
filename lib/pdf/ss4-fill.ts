/**
 * SS-4 PDF Auto-Fill — Coordinate-based text drawing
 *
 * Uses a pre-flattened SS-4 template (no XFA, no form fields) and draws
 * text at precise pixel coordinates. This avoids the XFA stripping issue
 * that caused blank PDFs when using pdf-lib's form field API.
 *
 * Template: public/templates/ss4-blank.pdf (created via qpdf --flatten-annotations)
 * Coordinates: measured from grid overlay on Rev. December 2025 form
 * Page size: 612 x 792 (US Letter)
 *
 * COORDINATE MAP (y=0 at bottom, verified 2026-03-24):
 *
 *   LINE 1  (y≈700): Legal name — x=75
 *   LINE 2  (y≈672): Trade name — x=75       LINE 3 (y≈672): Care of — x=435
 *   LINE 4a (y≈650): Mailing street — x=75   LINE 5a (y≈650): Street addr — x=435
 *   LINE 4b (y≈632): City/state/ZIP — x=75   LINE 5b (y≈632): City/state/ZIP — x=435
 *   LINE 6  (y≈607): County/state — x=75
 *   LINE 7a (y≈580): Responsible party — x=75  LINE 7b (y≈580): SSN/ITIN — x=440
 *   LINE 8a (y≈553): LLC? Yes checkbox — x=349, No — x=393
 *   LINE 8b (y≈553): Members count — x=530
 *   LINE 8c (y≈535): US? Yes checkbox — x=487, No — x=555
 *   LINE 9a checkboxes (y≈515 to y≈432)
 *   LINE 9b (y≈422): State — x=410, Foreign — x=500
 *   LINE 10 (y≈388): Started new biz checkbox — x=63, specify — x=220
 *   LINE 11 (y≈330): Date — x=75             LINE 12 (y≈330): Closing month — x=410
 *   LINE 16 Other (y≈198): checkbox — x=438, specify — x=490
 *   LINE 18 (y≈160): Yes — x=474, No — x=519
 *   DESIGNEE name (y≈118): x=150              phone (y≈118): x=465
 *   DESIGNEE addr (y≈100): x=150              fax (y≈100): x=465
 *   NAME+TITLE (y≈68): x=150                  APPLICANT phone (y≈78): x=465
 *   SIGNATURE (y≈45): left blank              APPLICANT fax (y≈50): x=465
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { readFile } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"

// Tony Durante LLC — Third Party Designee info (address + contact only, no personal name)
const DESIGNEE = {
  address: "10225 Ulmerton Rd 3D, Largo, FL 33771",
  phone: "727-423-4285",
  fax: "+1 727 513-5584",
}

// TD LLC Office — mailing address for all client LLCs
const TD_OFFICE = {
  street: "10225 Ulmerton Rd 3D",
  cityStateZip: "Largo FL 33771",
  fax: "+1 727 513-5584",
}

/**
 * County and state mapping for Line 6.
 * Based on where the registered agent is located in each state.
 */
const STATE_COUNTY_MAP: Record<string, string> = {
  NM: "Bernalillo - New Mexico",
  WY: "Sheridan - Wyoming",
  FL: "Pinellas - Florida",
  DE: "New Castle - Delaware",
}

export type EntityType = "SMLLC" | "MMLLC" | "Corporation"

export interface SS4FillData {
  companyName: string
  tradeName?: string
  entityType: EntityType
  stateOfFormation: string // 2-letter code (NM, WY, FL, DE)
  formationDate: string // YYYY-MM-DD or MM/DD/YYYY
  memberCount: number

  responsiblePartyName: string
  responsiblePartyItin?: string // ITIN or "Foreigner"
  responsiblePartyPhone?: string
  responsiblePartyTitle: string // "Owner" or "Member"

  countyAndState?: string
  hasAppliedBefore?: boolean
  previousEin?: string
}

/** Format date from YYYY-MM-DD to MM/DD/YYYY (IRS format) */
function formatDate(d: string | undefined): string {
  if (!d) return ""
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d
  const parts = d.split("-")
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`
  return d
}

/** Load the pre-flattened SS-4 template (no XFA, no form fields) */
async function loadTemplate(): Promise<Buffer> {
  // Try filesystem first (works locally and in some Vercel configs)
  const templatePath = join(process.cwd(), "public", "templates", "ss4-blank.pdf")
  if (existsSync(templatePath)) {
    return readFile(templatePath)
  }

  // Fallback: fetch from the app's own static assets (Vercel CDN)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
    || "https://app.tonydurante.us"
  const res = await fetch(`${baseUrl}/templates/ss4-blank.pdf`)
  if (!res.ok) throw new Error(`Failed to load SS-4 template: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const FONT_SIZE = 10
const SMALL_SIZE = 8
const CHECK_SIZE = 8

/**
 * Fill SS-4 PDF by drawing text at coordinates on the flat template.
 * Returns filled PDF as Uint8Array.
 */
export async function fillSS4(data: SS4FillData): Promise<Uint8Array> {
  const templateBytes = await loadTemplate()
  const pdf = await PDFDocument.load(templateBytes)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold)
  const page = pdf.getPage(0)
  const black = rgb(0, 0, 0)

  const text = (x: number, y: number, value: string | undefined, size = FONT_SIZE) => {
    if (!value) return
    page.drawText(value, { x, y, size, font, color: black })
  }

  // Draw X centered in an 8x8 checkbox square
  const check = (x: number, y: number) => {
    page.drawText("X", { x: x + 1, y: y + 1.5, size: CHECK_SIZE, font: boldFont, color: black })
  }

  // === LINE 1: Legal name (blank area below label) ===
  text(75, 687, data.companyName)

  // === LINE 2: Trade name ===
  if (data.tradeName) text(75, 660, data.tradeName)

  // === LINE 4a: Mailing address (TD office) ===
  text(75, 637, TD_OFFICE.street)

  // === LINE 4b: City, state, ZIP ===
  text(75, 618, TD_OFFICE.cityStateZip)

  // === LINE 6: County and state ===
  const countyState = data.countyAndState || STATE_COUNTY_MAP[data.stateOfFormation] || ""
  text(75, 593, countyState)

  // === LINE 7a: Name of responsible party ===
  text(75, 567, data.responsiblePartyName)

  // === LINE 7b: SSN, ITIN, or EIN ===
  text(440, 567, data.responsiblePartyItin || "Foreigner")

  // === LINE 8a: Is this for an LLC? = Yes ===
  check(255, 542)

  // === LINE 8b: Number of LLC members ===
  text(530, 543, String(data.memberCount))

  // === LINE 8c: Was LLC organized in US? = Yes ===
  check(493, 530)

  // === LINE 9a: Type of entity ===
  switch (data.entityType) {
    case "SMLLC":
      // "Other (specify)" checkbox + text (c1_3[15]: x=61, y=434)
      check(61, 434)
      text(155, 436, "Foreign owned disregarded entity", SMALL_SIZE)
      break
    case "MMLLC":
      // "Partnership" checkbox (c1_3[2]: x=61, y=494)
      check(61, 494)
      break
    case "Corporation":
      // "Corporation" checkbox + form number
      check(61, 478)
      text(262, 480, "1120")
      break
  }

  // === LINE 10: Reason — Started new business === (c1_4[0]: x=61, y=386)
  check(61, 386)
  text(220, 388, "Any Legal Activity", SMALL_SIZE)

  // === LINE 11: Date business started ===
  text(75, 318, formatDate(data.formationDate))

  // === LINE 12: Closing month ===
  text(410, 318, "December")

  // === LINE 16: Principal activity — Other (specify) === (c1_6[11]: x=320, y=194)
  check(320, 194)
  text(385, 196, "Any Legal Activity", SMALL_SIZE)

  // === LINE 18: Applied for EIN before? === (c1_7[0]=Yes x=356,y=158 / c1_7[1]=No x=399,y=158)
  if (data.hasAppliedBefore) {
    check(356, 158)
    if (data.previousEin) text(220, 142, data.previousEin)
  } else {
    check(399, 158)
  }

  // === THIRD PARTY DESIGNEE (company info only, no personal name) ===
  text(150, 108, "Tony Durante LLC")
  text(465, 108, DESIGNEE.phone)
  text(150, 90, DESIGNEE.address)
  text(465, 90, DESIGNEE.fax)

  // === SIGNATURE SECTION ===
  text(150, 58, `${data.responsiblePartyName} - ${data.responsiblePartyTitle}`)
  text(465, 68, data.responsiblePartyPhone || "")
  text(465, 40, TD_OFFICE.fax)

  return pdf.save()
}

/**
 * Fill SS-4 and return as Buffer (convenience wrapper for MCP tools).
 */
export async function generateSS4PDF(data: SS4FillData): Promise<Buffer> {
  const bytes = await fillSS4(data)
  return Buffer.from(bytes)
}
