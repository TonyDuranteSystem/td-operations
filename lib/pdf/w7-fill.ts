/**
 * W-7 PDF Auto-Fill
 * Downloads blank W-7 from IRS.gov, fills form fields with client data from itin_submissions.
 * Returns filled PDF as Uint8Array.
 *
 * Field mapping verified against Form W-7 (Rev. December 2024) using debug PDF.
 * pdf-lib strips XFA data (not supported) but AcroForm fields work fine.
 *
 * FIELD MAP (verified 2026-03-18):
 *   f1_01 = Relationship for reason d
 *   f1_02 = Name/SSN for d or e
 *   f1_03 = SSN/ITIN for d or e
 *   f1_04 = "Other" text for reason h
 *   f1_05 = Treaty country (for a and f)
 *   f1_06 = Treaty article number (for a and f)
 *   f1_07 = Line 1a First name
 *   f1_08 = Line 1a Middle name
 *   f1_09 = Line 1a Last name
 *   f1_10 = Line 1b First name at birth
 *   f1_11 = Line 1b Middle name at birth
 *   f1_12 = Line 1b Last name at birth
 *   f1_13 = Line 2 Mailing street
 *   f1_14 = Line 2 Mailing city/state/ZIP
 *   f1_15 = Line 3 Foreign street
 *   f1_16 = Line 3 Foreign city/state/country
 *   f1_17 = Line 4 Date of birth
 *   f1_18 = Line 4 Country of birth
 *   f1_19 = Line 4 City/state of birth
 *   c1_10[0/1] = Line 5 Male/Female
 *   f1_20 = Line 6a Country of citizenship
 *   f1_21 = Line 6b Foreign tax ID
 *   f1_22 = Line 6c US visa info
 *   c1_11[0] = Line 6d Passport checkbox
 *   f1_23 = Line 6d Other document type
 *   f1_24 = Line 6d Issued by
 *   f1_25 = Line 6d Number
 *   f1_26 = Line 6d Exp date
 *   f1_27 = Date of entry
 *   c1_12[0/1] = Line 6e No/Yes previous ITIN
 *   f1_28-30 = Line 6f ITIN digits
 *   f1_31-33 = Line 6f IRSN digits
 *   f1_34 = Line 6f First name issued under
 *   f1_35 = Line 6f Middle name
 *   f1_36 = Line 6f Last name
 *   f1_37 = Line 6g College/company
 *   f1_38 = Line 6g City/state
 *   f1_39 = Line 6g Length of stay
 *   f1_40 = Sign Here Phone number
 *   f1_41 = Delegate name
 *   f1_42 = AA Phone
 *   f1_43 = AA Fax
 *   f1_44 = AA Name and title
 *   f1_45 = AA Name of company
 *   f1_46 = AA EIN
 *   f1_47 = AA PTIN
 *   f1_48 = AA Office code
 */

import { PDFDocument } from "pdf-lib"
import { embedUnicodeFonts } from "./unicode-fonts"

const W7_PDF_URL = "https://www.irs.gov/pub/irs-pdf/fw7.pdf"

// Tony Durante LLC as Acceptance Agent
const AGENT = {
  nameAndTitle: "Antonio Durante, Certified Acceptance Agent",
  company: "Tony Durante LLC",
  ein: "92-3081958",
  phone: "+1 (727) 452-1093",
  address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
}

export interface W7FillData {
  // Line 1a - Name
  first_name: string
  middle_name?: string
  last_name: string
  // Line 1b - Name at birth (if different)
  name_at_birth?: string
  // Line 3 - Foreign address
  foreign_street: string
  foreign_city: string
  foreign_state_province?: string
  foreign_zip: string
  foreign_country: string
  // Line 4 - Birth info
  dob: string // YYYY-MM-DD or MM/DD/YYYY
  country_of_birth: string
  city_of_birth: string
  // Line 5 - Gender
  gender: "Male" | "Female"
  // Line 6a - Citizenship
  citizenship: string
  // Line 6b - Foreign tax ID
  foreign_tax_id?: string
  // Line 6c - US visa
  us_visa_type?: string
  us_visa_number?: string
  us_visa_expiry?: string
  // Line 6d - Passport
  passport_number: string
  passport_country: string
  passport_expiry: string // YYYY-MM-DD or MM/DD/YYYY
  // Entry date
  us_entry_date?: string // YYYY-MM-DD or MM/DD/YYYY
  // Line 6e/6f - Previous ITIN
  has_previous_itin: boolean
  previous_itin?: string
  // Reason - default is "b" (nonresident alien filing US return)
  reason?: "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h"
}

/** Format date from YYYY-MM-DD to MM/DD/YYYY (IRS format) */
function formatDate(d: string | undefined): string {
  if (!d) return ""
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d
  const parts = d.split("-")
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`
  return d
}

/** Short prefix for field names */
const P = "topmostSubform[0].Page1[0]"

/** Download blank W-7 PDF from IRS.gov */
async function downloadW7(): Promise<Buffer> {
  const res = await fetch(W7_PDF_URL)
  if (!res.ok) throw new Error(`Failed to download W-7: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Fill W-7 PDF with client data. Returns filled PDF as Uint8Array. */
export async function fillW7(data: W7FillData): Promise<Uint8Array> {
  const pdfBytes = await downloadW7()
  const pdf = await PDFDocument.load(pdfBytes)
  const { regular: unicodeFont } = await embedUnicodeFonts(pdf)
  const form = pdf.getForm()

  const setText = (fieldName: string, value: string | undefined) => {
    if (!value) return
    try { form.getTextField(fieldName).setText(value) } catch { /* skip */ }
  }

  const setCheck = (fieldName: string, check: boolean) => {
    if (!check) return
    try { form.getCheckBox(fieldName).check() } catch { /* skip */ }
  }

  // === APPLICATION TYPE ===
  setCheck(`${P}.c1_1[0]`, true) // Apply for new ITIN

  // === REASON ===
  const reason = data.reason || "b"
  const reasonMap: Record<string, string> = {
    a: `${P}.c1_2[0]`, b: `${P}.c1_3[0]`, c: `${P}.c1_4[0]`,
    d: `${P}.c1_5[0]`, e: `${P}.c1_6[0]`, f: `${P}.c1_7[0]`,
    g: `${P}.c1_8[0]`, h: `${P}.c1_9[0]`,
  }
  if (reasonMap[reason]) setCheck(reasonMap[reason], true)

  // === LINE 1a - NAME ===
  setText(`${P}.f1_07[0]`, data.first_name)
  setText(`${P}.f1_08[0]`, data.middle_name)
  setText(`${P}.f1_09[0]`, data.last_name)

  // === LINE 1b - NAME AT BIRTH ===
  if (data.name_at_birth) {
    const parts = data.name_at_birth.trim().split(/\s+/)
    setText(`${P}.f1_10[0]`, parts[0])
    if (parts.length > 2) setText(`${P}.f1_11[0]`, parts.slice(1, -1).join(" "))
    if (parts.length > 1) setText(`${P}.f1_12[0]`, parts[parts.length - 1])
  }

  // === LINE 2 - MAILING ADDRESS (Tony Durante LLC office) ===
  setText(`${P}.f1_13[0]`, `c/o ${AGENT.company}, ${AGENT.address.split(",")[0]}`)
  setText(`${P}.f1_14[0]`, "Largo, FL 33771, United States")

  // === LINE 3 - FOREIGN ADDRESS ===
  setText(`${P}.f1_15[0]`, data.foreign_street)
  const foreignAddr = [data.foreign_city, data.foreign_state_province, data.foreign_zip, data.foreign_country]
    .filter(Boolean).join(", ")
  setText(`${P}.f1_16[0]`, foreignAddr)

  // === LINE 4 - DATE OF BIRTH & COUNTRY/CITY OF BIRTH ===
  setText(`${P}.Line4_ReadOrder[0].f1_17[0]`, formatDate(data.dob))
  setText(`${P}.f1_18[0]`, data.country_of_birth)
  setText(`${P}.f1_19[0]`, data.city_of_birth)

  // === LINE 5 - GENDER ===
  if (data.gender === "Male") setCheck(`${P}.c1_10[0]`, true)
  else setCheck(`${P}.c1_10[1]`, true)

  // === LINE 6a - COUNTRY OF CITIZENSHIP ===
  setText(`${P}.f1_20[0]`, data.citizenship)

  // === LINE 6b - FOREIGN TAX ID ===
  setText(`${P}.f1_21[0]`, data.foreign_tax_id)

  // === LINE 6c - US VISA ===
  if (data.us_visa_type) {
    const visaInfo = [data.us_visa_type, data.us_visa_number, data.us_visa_expiry].filter(Boolean).join(", ")
    setText(`${P}.f1_22[0]`, visaInfo)
  }

  // === LINE 6d - PASSPORT ===
  setCheck(`${P}.c1_11[0]`, true) // Passport checkbox
  setText(`${P}.Issued_ReadOrder[0].f1_24[0]`, data.passport_country)
  setText(`${P}.Issued_ReadOrder[0].f1_25[0]`, data.passport_number)
  setText(`${P}.Issued_ReadOrder[0].f1_26[0]`, formatDate(data.passport_expiry))

  // === DATE OF ENTRY ===
  if (data.us_entry_date) {
    setText(`${P}.f1_27[0]`, formatDate(data.us_entry_date))
  }

  // === LINE 6e - PREVIOUS ITIN ===
  if (data.has_previous_itin) {
    setCheck(`${P}.c1_12[1]`, true) // Yes
    if (data.previous_itin) {
      const itin = data.previous_itin.replace(/\D/g, "")
      if (itin.length >= 9) {
        setText(`${P}.ITIN[0].f1_28[0]`, itin.substring(0, 3))
        setText(`${P}.ITIN[0].f1_29[0]`, itin.substring(3, 5))
        setText(`${P}.ITIN[0].f1_30[0]`, itin.substring(5, 9))
      }
      setText(`${P}.f1_34[0]`, data.first_name)
      setText(`${P}.f1_36[0]`, data.last_name)
    }
  } else {
    setCheck(`${P}.c1_12[0]`, true) // No/Don't know
  }

  // === ACCEPTANCE AGENT SECTION ===
  setText(`${P}.f1_42[0]`, AGENT.phone)       // Phone
  // f1_43 = Fax (skip)
  setText(`${P}.f1_44[0]`, AGENT.nameAndTitle) // Name and title
  setText(`${P}.f1_45[0]`, AGENT.company)      // Name of company
  setText(`${P}.f1_46[0]`, AGENT.ein)          // EIN

  // Replace the form's default Helvetica/WinAnsi appearances with the Unicode
  // font so non-Latin-1 characters (e.g. Maltese ħ) render correctly when flattened.
  form.updateFieldAppearances(unicodeFont)
  // Flatten so fields appear as static text
  form.flatten()

  return pdf.save()
}
