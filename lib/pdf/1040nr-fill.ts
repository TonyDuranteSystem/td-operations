/**
 * 1040-NR + Schedule OI PDF Auto-Fill for ITIN Applications
 *
 * For ITIN applications, the 1040-NR is filed as a "supporting tax return"
 * with all income lines at $0. The purpose is solely to support the W-7.
 *
 * Field mappings verified 2026-03-18 via debug PDFs with field names rendered.
 *
 * 1040-NR PAGE 1 KEY FIELDS (re-verified 2026-05-13 via scripts/debug-pdf-fields.ts):
 *   f1_01 = tax year beginning (header)
 *   f1_02 = tax year ending (header)
 *   f1_03 = tax year suffix
 *   f1_04 = (top header row write-in, ~Y=708)
 *   f1_05–f1_07 = Deceased date MM/DD/YY widgets
 *   f1_08–f1_10 = Spouse date MM/DD/YY widgets
 *   f1_11 = "Other" line text (under Filed pursuant), Y=696
 *   f1_12 = (Y=696 middle — NOT a name field)
 *   f1_13 = (Y=696 right — NOT a name field)
 *   f1_14 = Your first name and middle initial (Y=666)   ← was wrong as f1_12
 *   f1_15 = Last name (Y=666)                            ← was wrong as f1_13
 *   f1_16 = Your identifying number / ITIN (Y=666)       ← left blank
 *   f1_17 = Home address (street) (Y=642)                ← was wrong as f1_14
 *   f1_18 = Apt. no. (Y=642)                             ← was wrong as f1_15
 *   f1_19 = City, town (Y=618)                           ← was wrong as f1_17
 *   f1_20 = State (Y=618)
 *   f1_21 = ZIP code (Y=618)
 *   f1_22 = Foreign country name (Y=594)
 *   f1_23 = Foreign province/state/county (Y=594)
 *   f1_24 = Foreign postal code (Y=594)
 *   c1_5[0-4] = Filing status: Single/MFS/QSS/Estate/Trust
 *   c1_6[0/1] = Digital assets Yes/No
 *   f1_42 = Line 1a (Wages)
 *   f1_54 = Line 1z (Total wages)
 *   f1_69 = Line 9 (Total effectively connected income)
 *   f1_70 = Line 10 (Adjustments)
 *   f1_71 = Line 11a (AGI)
 *
 * 1040-NR PAGE 2 KEY FIELDS (verified):
 *   f2_01 = Line 11b (AGI carried forward)
 *   f2_02 = Line 12 (Itemized deductions)
 *   f2_06 = Line 14 (Total deductions)
 *   f2_07 = Line 15 (Taxable income)
 *   f2_09 = Line 16 (Tax)
 *   f2_10 = Line 17
 *   f2_11 = Line 18 (Tax + Schedule 2)
 *   f2_13 = Line 20
 *   f2_14 = Line 21
 *   f2_15 = Line 22
 *   f2_19 = Line 23d
 *   f2_20 = Line 24 (Total tax)
 *   f2_24 = Line 25d (Total withholding)
 *   f2_35 = Line 33 (Total payments)
 *   f2_42 = Line 37 (Amount you owe)
 *   f2_51 = Preparer's name
 *   f2_52 = PTIN
 *   f2_53 = Firm's name
 *   f2_54 = Phone no.
 *   f2_55 = Firm's address
 *   f2_56 = Firm's EIN
 */

import { PDFDocument } from "pdf-lib"
import { embedUnicodeFonts } from "./unicode-fonts"

const F1040NR_URL = "https://www.irs.gov/pub/irs-pdf/f1040nr.pdf"
const SCHEDULE_OI_URL = "https://www.irs.gov/pub/irs-pdf/f1040nro.pdf"

const PREPARER = {
  name: "Antonio Durante",
  company: "Tony Durante LLC",
  ein: "83-4299021",
  ptin: "P02389222",
  phone: "+1 (727) 452-1093",
  address: "11125 Park Blvd, Suite 104-153, Seminole, FL 33772",
}

// CAA mailing address used as the taxpayer's "home address" for ITIN apps —
// the IRS routes correspondence to the CAA. No "c/o" prefix per 2026-05-13.
const CAA_HOME = {
  street: "11125 Park Blvd",
  apt: "104-153",
  city: "Seminole",
  state: "FL",
  zip: "33772",
}

export interface F1040NRFillData {
  first_name: string
  middle_initial?: string
  last_name: string
  foreign_country: string
  foreign_state_province?: string
  foreign_zip?: string
  citizenship: string
  us_visa_type?: string
  days_in_us_current?: string
  days_in_us_prior1?: string
  days_in_us_prior2?: string
}

async function downloadPdf(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const P1 = "topmostSubform[0].Page1[0]"
const P2 = "topmostSubform[0].Page2[0]"

/** Fill 1040-NR for ITIN application (all income = $0) */
export async function fill1040NR(data: F1040NRFillData): Promise<Uint8Array> {
  const pdfBytes = await downloadPdf(F1040NR_URL)
  const pdf = await PDFDocument.load(pdfBytes)
  const { regular: unicodeFont } = await embedUnicodeFonts(pdf)
  const form = pdf.getForm()

  const setText = (name: string, val: string | undefined) => {
    if (!val) return
    try {
      form.getTextField(name).setText(val)
    } catch (err) {
      // Surface failures instead of silently swallowing — a silent catch
      // hid the wrong-field-map bug that landed Valerio Di Santo's name
      // and address in the Deceased/Spouse and First Name slots (2026-05-13).
      console.warn(
        `[1040nr-fill] setText failed for "${name}" value="${val}":`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  const setCheck = (name: string, check: boolean) => {
    if (!check) return
    try {
      form.getCheckBox(name).check()
    } catch (err) {
      console.warn(
        `[1040nr-fill] setCheck failed for "${name}":`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // === HEADER — Name (Y=666, corrected field map) ===
  const fullFirst = data.middle_initial
    ? `${data.first_name} ${data.middle_initial}`
    : data.first_name
  setText(`${P1}.f1_14[0]`, fullFirst)      // Your first name and middle initial
  setText(`${P1}.f1_15[0]`, data.last_name) // Last name
  // f1_16 = ITIN/SSN — left blank (applying for it)

  // === ADDRESS (Tony Durante LLC office as mailing address) ===
  // Field map shifted in 2026-05-13 fix: home address is f1_17 (was wrongly f1_14).
  // No "c/o" prefix on the street line.
  setText(`${P1}.f1_17[0]`, CAA_HOME.street) // Home address (Y=642)
  setText(`${P1}.f1_18[0]`, CAA_HOME.apt)    // Apt. no. (Y=642)
  setText(`${P1}.f1_19[0]`, CAA_HOME.city)   // City (Y=618)
  setText(`${P1}.f1_20[0]`, CAA_HOME.state)  // State (Y=618)
  setText(`${P1}.f1_21[0]`, CAA_HOME.zip)    // ZIP code (Y=618)

  // Foreign address
  setText(`${P1}.f1_22[0]`, data.foreign_country)
  setText(`${P1}.f1_23[0]`, data.foreign_state_province)
  setText(`${P1}.f1_24[0]`, data.foreign_zip)

  // === FILING STATUS — Single ===
  setCheck(`${P1}.c1_5[0]`, true)

  // === DIGITAL ASSETS — No ===
  setCheck(`${P1}.c1_6[1]`, true)

  // === INCOME — All $0 ===
  setText(`${P1}.f1_42[0]`, "0")  // Line 1a — Wages
  setText(`${P1}.f1_54[0]`, "0")  // Line 1z — Total wages
  setText(`${P1}.f1_69[0]`, "0")  // Line 9 — Total effectively connected income
  setText(`${P1}.f1_70[0]`, "0")  // Line 10 — Adjustments
  setText(`${P1}.f1_71[0]`, "0")  // Line 11a — AGI

  // === PAGE 2 — TAX AND CREDITS — All $0 ===
  setText(`${P2}.f2_01[0]`, "0")  // Line 11b — AGI
  setText(`${P2}.f2_02[0]`, "0")  // Line 12 — Itemized deductions
  setText(`${P2}.f2_06[0]`, "0")  // Line 14 — Total deductions
  setText(`${P2}.f2_07[0]`, "0")  // Line 15 — Taxable income
  setText(`${P2}.f2_09[0]`, "0")  // Line 16 — Tax
  setText(`${P2}.f2_10[0]`, "0")  // Line 17 — Schedule 2
  setText(`${P2}.f2_11[0]`, "0")  // Line 18 — Tax + Schedule 2
  setText(`${P2}.f2_13[0]`, "0")  // Line 20 — Schedule 3
  setText(`${P2}.f2_14[0]`, "0")  // Line 21 — Total credits
  setText(`${P2}.f2_15[0]`, "0")  // Line 22 — Tax minus credits
  setText(`${P2}.f2_19[0]`, "0")  // Line 23d — Other taxes total
  setText(`${P2}.f2_20[0]`, "0")  // Line 24 — Total tax
  setText(`${P2}.f2_24[0]`, "0")  // Line 25d — Total withholding
  setText(`${P2}.f2_35[0]`, "0")  // Line 33 — Total payments
  setText(`${P2}.f2_42[0]`, "0")  // Line 37 — Amount you owe

  // === PAID PREPARER ===
  setText(`${P2}.f2_51[0]`, PREPARER.name)     // Preparer's name
  setText(`${P2}.f2_52[0]`, PREPARER.ptin)     // PTIN
  setText(`${P2}.f2_53[0]`, PREPARER.company)  // Firm's name
  setText(`${P2}.f2_54[0]`, PREPARER.phone)    // Phone no.
  setText(`${P2}.f2_55[0]`, PREPARER.address)  // Firm's address
  setText(`${P2}.f2_56[0]`, PREPARER.ein)      // Firm's EIN

  // Apply Unicode font to all field appearances before flattening
  form.updateFieldAppearances(unicodeFont)
  form.flatten()
  return pdf.save()
}

/** Fill Schedule OI for ITIN application */
export async function fillScheduleOI(data: F1040NRFillData): Promise<Uint8Array> {
  const pdfBytes = await downloadPdf(SCHEDULE_OI_URL)
  const pdf = await PDFDocument.load(pdfBytes)
  const { regular: unicodeFont } = await embedUnicodeFonts(pdf)
  const form = pdf.getForm()

  // Schedule OI uses prefix: form1040-NR[0].Page1[0]
  const P = "form1040-NR[0].Page1[0]"

  const setText = (name: string, val: string | undefined) => {
    if (!val) return
    try {
      form.getTextField(name).setText(val)
    } catch (err) {
      // Surface failures instead of silently swallowing — a silent catch
      // hid the wrong-field-map bug that landed Valerio Di Santo's name
      // and address in the Deceased/Spouse and First Name slots (2026-05-13).
      console.warn(
        `[1040nr-fill] setText failed for "${name}" value="${val}":`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  const setCheck = (name: string, check: boolean) => {
    if (!check) return
    try {
      form.getCheckBox(name).check()
    } catch (err) {
      console.warn(
        `[1040nr-fill] setCheck failed for "${name}":`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Header
  const fullName = data.middle_initial
    ? `${data.first_name} ${data.middle_initial} ${data.last_name}`
    : `${data.first_name} ${data.last_name}`
  setText(`${P}.f1_1[0]`, fullName)
  // f1_2 = ITIN — left blank

  // Item A — Citizenship
  setText(`${P}.f1_3[0]`, data.citizenship)

  // Item B — Tax residence
  setText(`${P}.f1_4[0]`, data.citizenship) // Same as citizenship for most

  // Item C — Green card: No
  setCheck(`${P}.c1_1[1]`, true)

  // Item D — Never US citizen, never green card holder
  setCheck(`${P}.c1_2[1]`, true) // D1: No
  setCheck(`${P}.c1_3[1]`, true) // D2: No

  // Item E — Visa type
  setText(`${P}.f1_5[0]`, data.us_visa_type || "N/A - No US visa")

  // Item F — Visa change: No
  setCheck(`${P}.c1_4[1]`, true)

  // Item H — Days in US
  setText(`${P}.f1_23[0]`, data.days_in_us_prior2 || "0")
  setText(`${P}.f1_24[0]`, data.days_in_us_prior1 || "0")
  setText(`${P}.f1_25[0]`, data.days_in_us_current || "0")

  // Item I — Prior year return: No
  setCheck(`${P}.c1_6[1]`, true)

  // Apply Unicode font to all field appearances before flattening
  form.updateFieldAppearances(unicodeFont)
  form.flatten()
  return pdf.save()
}
