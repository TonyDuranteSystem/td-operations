/**
 * SS-4 PDF Auto-Fill
 * Downloads blank SS-4 from IRS.gov, fills form fields with client data from CRM.
 * Returns filled PDF as Uint8Array.
 *
 * Field mapping verified against Form SS-4 (Rev. December 2025) using coordinate analysis
 * of AcroForm fields extracted with pdf-lib.
 *
 * FIELD MAP (verified 2026-03-24 via position analysis):
 *
 *   HEADER:
 *   f1_1  = EIN (maxLen=10, pre-printed, left blank on submission)
 *
 *   LINE 1: Legal name of entity
 *   f1_2  = Legal name (e.g., "Outriders LLC")
 *
 *   LINE 2: Trade name
 *   f1_3  = Trade name (if different from line 1, usually blank)
 *
 *   LINE 3: Executor/administrator/trustee/"care of" name
 *   f1_4  = Care of name (blank for our LLCs)
 *
 *   LINE 4a: Mailing address
 *   f1_5  = Street (inside Line4ReadOrder group)
 *     → Always TD office: "10225 Ulmerton Rd 3D"
 *
 *   LINE 4b: City, state, ZIP
 *   f1_6  = City/state/ZIP
 *     → Always "Largo FL 33771"
 *
 *   LINE 5a-5b: Different street/city (if different from 4a-4b)
 *   f1_7  = Street (blank)
 *   f1_8  = City/state/ZIP (blank)
 *
 *   LINE 6: County and state where principal business is located
 *   f1_9  = County + State (from RA address, e.g., "Bernalillo - New Mexico")
 *
 *   LINE 7a: Name of responsible party
 *   f1_10 = Responsible party full name (from contacts.full_name)
 *
 *   LINE 7b: SSN, ITIN, or EIN
 *   f1_11 = SSN/ITIN (maxLen=11). "Foreigner" for non-US without SSN/ITIN,
 *           or actual ITIN (XXX-XX-XXXX) if they have one.
 *
 *   LINE 8a: Is this application for an LLC?
 *   c1_1[0] = Yes
 *   c1_1[1] = No
 *
 *   LINE 8b: Number of LLC members
 *   f1_12 = Number (e.g., "1" for SMLLC, "2" for MMLLC)
 *
 *   LINE 8c: Was the LLC organized in the United States?
 *   c1_2[0] = Yes
 *   c1_2[1] = No
 *
 *   LINE 9a: Type of entity (16 checkboxes in 3-column layout)
 *   LEFT column (x≈61):
 *     c1_3[0]  = Sole proprietor      → f1_13 (SSN, maxLen=11)
 *     c1_3[2]  = Partnership
 *     c1_3[4]  = Corporation           → f1_16 (form number)
 *     c1_3[6]  = Personal service corp
 *     c1_3[9]  = Church
 *     c1_3[12] = Other nonprofit       → f1_18 (specify)
 *     c1_3[15] = Other (specify)       → f1_19 (specify text, unlimited)
 *   MIDDLE column (x≈334):
 *     c1_3[1]  = Estate                → f1_14 (SSN decedent, maxLen=11)
 *     c1_3[3]  = Plan administrator    → f1_15 (TIN, maxLen=11)
 *     c1_3[5]  = Trust                 → f1_17 (TIN grantor, maxLen=11)
 *     c1_3[7]  = Military/National Guard
 *     c1_3[10] = Farmers' cooperative
 *     c1_3[13] = REMIC
 *   RIGHT column (x≈442):
 *     c1_3[8]  = State/local government
 *     c1_3[11] = Federal government
 *     c1_3[14] = Indian tribal
 *
 *   ENTITY TYPE RULES:
 *     SMLLC  → c1_3[15] "Other" + f1_19 = "Foreign owned disregarded entity"
 *     MMLLC  → c1_3[2] "Partnership"
 *     Corp   → c1_3[4] "Corporation" + f1_16 = form number (e.g., "1120")
 *
 *   LINE 9b: If corporation, state or foreign country
 *   f1_21 = State
 *   f1_22 = Foreign country
 *
 *   GEN: f1_20 = Group Exemption Number (blank)
 *
 *   LINE 10: Reason for applying (9 checkboxes in 2-column layout)
 *   LEFT column:
 *     c1_4[0] = Started new business   → f1_25 (type), f1_26 (continuation)
 *     c1_4[3] = Hired employees
 *     c1_4[5] = Compliance with IRS withholding
 *     c1_4[7] = Other                  → f1_30 (specify)
 *   RIGHT column:
 *     c1_4[8] = Banking purpose        → f1_24 (specify)
 *     c1_4[1] = Changed type of org    → f1_27 (new type)
 *     c1_4[2] = Purchased going biz
 *     c1_4[4] = Created a trust        → f1_28 (type)
 *     c1_4[6] = Created a pension plan → f1_29 (type)
 *
 *   → Always: c1_4[0] + f1_25 = "Any Legal Activity"
 *
 *   LINE 11: Date business started
 *   f1_31 = Date (MM/DD/YYYY from accounts.formation_date)
 *
 *   LINE 12: Closing month of accounting year
 *   f1_32 = "December" (always)
 *
 *   LINE 13: Highest number of employees (skip, no employees)
 *   f1_33 = Agricultural, f1_34 = Household, f1_35 = Other
 *
 *   LINE 14: File Form 944 annually?
 *   c1_5[0] = Checkbox (skip)
 *
 *   LINE 15: First date wages paid
 *   f1_36 = (blank, no employees)
 *
 *   LINE 16: Principal activity (12 checkboxes)
 *   c1_6[0-11] in reading order:
 *     [0]=Construction, [1]=Real estate, [2]=Rental, [3]=Manufacturing,
 *     [4]=Transportation, [5]=Finance, [6]=Health care, [7]=Accommodation,
 *     [8]=Wholesale-broker, [9]=Wholesale-other, [10]=Retail,
 *     [11]=Other (specify) → f1_37
 *   → Always: c1_6[11] + f1_37 = "Any Legal Activity"
 *
 *   LINE 17: Principal line of merchandise/services
 *   f1_38 = (blank or same as activity)
 *
 *   LINE 18: Has entity applied for EIN before?
 *   c1_7[0] = Yes → f1_39 (previous EIN, maxLen=10)
 *   c1_7[1] = No
 *
 *   THIRD PARTY DESIGNEE:
 *   f1_40 = Designee's name
 *   f1_41 = Address and ZIP code
 *   f1_42 = Designee's telephone
 *   f1_43 = Designee's fax
 *
 *   SIGNATURE (not a form field — left blank for e-sign overlay):
 *   f1_44 = Name and title (type or print clearly)
 *   f1_45 = Applicant's telephone number
 *   f1_46 = Applicant's fax number
 */

import { PDFDocument } from "pdf-lib"

const SS4_PDF_URL = "https://www.irs.gov/pub/irs-pdf/fss4.pdf"

/** Short prefix for form field names */
const P = "topmostSubform[0].Page1[0]"

// Tony Durante LLC — Third Party Designee info
const DESIGNEE = {
  name: "Antonio Durante",
  address: "18395 Gulf Blvd, Indian Shores FL 33785",
  phone: "727-423-4285",
  fax: "727-513-5584",
}

// TD LLC Office — mailing address for all client LLCs
const TD_OFFICE = {
  street: "10225 Ulmerton Rd 3D",
  city: "Largo",
  state: "FL",
  zip: "33771",
  fax: "727-513-5584",
}

/**
 * County and state mapping for Line 6.
 * Based on where the registered agent is located in each state.
 * Harbor Compliance RA addresses determine the county.
 */
const STATE_COUNTY_MAP: Record<string, string> = {
  NM: "Bernalillo - New Mexico",
  WY: "Sheridan - Wyoming",
  FL: "Pinellas - Florida",
  DE: "New Castle - Delaware",
}

export type EntityType = "SMLLC" | "MMLLC" | "Corporation"

export interface SS4FillData {
  // From accounts table
  companyName: string
  tradeName?: string // Line 2, usually blank
  entityType: EntityType
  stateOfFormation: string // 2-letter state code (NM, WY, FL, DE)
  formationDate: string // YYYY-MM-DD or MM/DD/YYYY
  memberCount: number // 1 for SMLLC, 2+ for MMLLC

  // From contacts table (responsible party = primary contact)
  responsiblePartyName: string
  responsiblePartyItin?: string // ITIN if they have one, otherwise "Foreigner"
  responsiblePartyPhone?: string // Foreign phone number
  responsiblePartyTitle: string // "Owner" for SMLLC, "Member" for MMLLC

  // Optional overrides
  countyAndState?: string // Override for Line 6 (auto-derived from stateOfFormation)
  hasAppliedBefore?: boolean // Line 18, default false
  previousEin?: string // If hasAppliedBefore = true
}

/** Format date from YYYY-MM-DD to MM/DD/YYYY (IRS format) */
function formatDate(d: string | undefined): string {
  if (!d) return ""
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) return d // Already MM/DD/YYYY
  const parts = d.split("-")
  if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0]}`
  return d
}

/** Download blank SS-4 PDF from IRS.gov */
async function downloadSS4(): Promise<Buffer> {
  const res = await fetch(SS4_PDF_URL)
  if (!res.ok) throw new Error(`Failed to download SS-4 from IRS: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Fill SS-4 PDF with client data. Returns filled PDF as Uint8Array.
 * Does NOT flatten — leaves signature area editable for e-sign overlay.
 */
export async function fillSS4(data: SS4FillData): Promise<Uint8Array> {
  const pdfBytes = await downloadSS4()
  const pdf = await PDFDocument.load(pdfBytes)
  const form = pdf.getForm()

  const setText = (fieldName: string, value: string | undefined) => {
    if (!value) return
    try {
      form.getTextField(fieldName).setText(value)
    } catch {
      /* Field not found or value too long — skip silently */
    }
  }

  const setCheck = (fieldName: string, check = true) => {
    if (!check) return
    try {
      form.getCheckBox(fieldName).check()
    } catch {
      /* Field not found — skip silently */
    }
  }

  // === LINE 1: Legal name ===
  setText(`${P}.f1_2[0]`, data.companyName)

  // === LINE 2: Trade name (if different) ===
  if (data.tradeName) {
    setText(`${P}.f1_3[0]`, data.tradeName)
  }

  // === LINE 4a: Mailing address (TD office) ===
  setText(`${P}.Line4ReadOrder[0].f1_5[0]`, TD_OFFICE.street)

  // === LINE 4b: City, state, ZIP ===
  setText(`${P}.Line4ReadOrder[0].f1_6[0]`, `${TD_OFFICE.city} ${TD_OFFICE.state} ${TD_OFFICE.zip}`)

  // === LINE 6: County and state where principal business is located ===
  const countyState = data.countyAndState || STATE_COUNTY_MAP[data.stateOfFormation] || ""
  setText(`${P}.f1_9[0]`, countyState)

  // === LINE 7a: Name of responsible party ===
  setText(`${P}.f1_10[0]`, data.responsiblePartyName)

  // === LINE 7b: SSN, ITIN, or EIN ===
  setText(`${P}.f1_11[0]`, data.responsiblePartyItin || "Foreigner")

  // === LINE 8a: Is this for an LLC? = Yes ===
  setCheck(`${P}.c1_1[0]`)

  // === LINE 8b: Number of LLC members ===
  setText(`${P}.f1_12[0]`, String(data.memberCount))

  // === LINE 8c: Was LLC organized in US? = Yes ===
  setCheck(`${P}.c1_2[0]`)

  // === LINE 9a: Type of entity ===
  switch (data.entityType) {
    case "SMLLC":
      // Other (specify) → "Foreign owned disregarded entity"
      setCheck(`${P}.c1_3[15]`)
      setText(`${P}.f1_19[0]`, "Foreign owned disregarded entity")
      break
    case "MMLLC":
      // Partnership
      setCheck(`${P}.c1_3[2]`)
      break
    case "Corporation":
      // Corporation (enter form number to be filed)
      setCheck(`${P}.c1_3[4]`)
      setText(`${P}.f1_16[0]`, "1120")
      break
  }

  // === LINE 10: Reason for applying — Started new business ===
  setCheck(`${P}.c1_4[0]`)
  setText(`${P}.f1_25[0]`, "Any Legal Activity")

  // === LINE 11: Date business started ===
  setText(`${P}.f1_31[0]`, formatDate(data.formationDate))

  // === LINE 12: Closing month of accounting year ===
  setText(`${P}.f1_32[0]`, "December")

  // Lines 13-15: No employees — leave blank

  // === LINE 16: Principal activity — Other ===
  setCheck(`${P}.c1_6[11]`)
  setText(`${P}.f1_37[0]`, "Any Legal Activity")

  // Line 17: Leave blank (covered by Line 16)

  // === LINE 18: Has entity applied for EIN before? ===
  if (data.hasAppliedBefore) {
    setCheck(`${P}.c1_7[0]`) // Yes
    if (data.previousEin) {
      setText(`${P}.f1_39[0]`, data.previousEin)
    }
  } else {
    setCheck(`${P}.c1_7[1]`) // No
  }

  // === THIRD PARTY DESIGNEE ===
  setText(`${P}.f1_40[0]`, DESIGNEE.name)
  setText(`${P}.f1_41[0]`, DESIGNEE.address)
  setText(`${P}.f1_42[0]`, DESIGNEE.phone)
  setText(`${P}.f1_43[0]`, DESIGNEE.fax)

  // === SIGNATURE SECTION (pre-fill name and title, signature added later) ===
  setText(`${P}.f1_44[0]`, `${data.responsiblePartyName} - ${data.responsiblePartyTitle}`)
  setText(`${P}.f1_45[0]`, data.responsiblePartyPhone || "")
  setText(`${P}.f1_46[0]`, TD_OFFICE.fax)

  // Flatten all fields EXCEPT we want the form to look clean
  // Signature will be overlaid as an image by the signing page
  form.flatten()

  return pdf.save()
}

/**
 * Fill SS-4 and return as Buffer (convenience wrapper for MCP tools).
 */
export async function generateSS4PDF(data: SS4FillData): Promise<Buffer> {
  const bytes = await fillSS4(data)
  return Buffer.from(bytes)
}
