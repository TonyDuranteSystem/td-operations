/**
 * Universal Form-to-Drive Module
 *
 * Generates a data summary PDF from any form submission and copies
 * uploaded files from Supabase Storage to the client's Google Drive folder.
 *
 * Used by all _review MCP tools when apply_changes=true.
 *
 * RULE: Every form submission (tax, formation, onboarding, ITIN, banking,
 * closure) MUST be converted to PDF and saved to Drive after review.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ─── Form Type Config ───

export interface FormDriveConfig {
  /** Supabase Storage bucket where uploads live */
  bucket: string
  /** Drive subfolder name inside the client's root folder */
  driveSubfolder: string
  /** Title for the summary PDF */
  pdfTitle: string
  /** Prefix for the PDF filename */
  filePrefix: string
  /** Sections to organize the data in the summary PDF */
  sections: FormSection[]
}

interface FormSection {
  title: string
  fields: { key: string; label: string }[]
}

// ─── Per-Form-Type Configurations ───

export const FORM_CONFIGS: Record<string, FormDriveConfig> = {
  tax_return: {
    bucket: "tax-form-uploads",
    driveSubfolder: "3. Tax",
    pdfTitle: "Tax Return Data Collection -- COMPLETE DATA PACKAGE",
    filePrefix: "Tax_Data",
    sections: [
      {
        title: "Company Information",
        fields: [
          { key: "llc_name", label: "LLC Name" },
          { key: "ein_number", label: "EIN" },
          { key: "state_of_incorporation", label: "State of Incorporation" },
          { key: "date_of_incorporation", label: "Formation Date" },
          { key: "principal_product_service", label: "Principal Product/Service" },
          { key: "us_business_activities", label: "US Business Activities" },
          // SMLLC wizard (2026-06-11) replaced the free-text us_business_activities
          // with a yes/no gate + conditional detail. Keep the old key (MMLLC/Corp
          // still use it) and add the two new SMLLC keys so the accountant's
          // package still shows the answer.
          { key: "has_us_business_activities", label: "Conducted US Business Activities? (SMLLC)" },
          { key: "us_business_activities_detail", label: "US Business Activities — Details (SMLLC)" },
          { key: "website_url", label: "Website" },
          { key: "state_revenue_breakdown", label: "Revenue Breakdown by State (Corp)" },
          { key: "new_activities_markets", label: "New Activities/Markets (Corp)" },
          { key: "has_payroll_w2", label: "Has Payroll/W-2 (Corp)" },
          { key: "payroll_details", label: "Payroll Details (Corp)" },
        ],
      },
      {
        title: "Owner / Member Information",
        fields: [
          { key: "owner_first_name", label: "First Name" },
          { key: "owner_last_name", label: "Last Name" },
          { key: "owner_email", label: "Email" },
          { key: "owner_phone", label: "Phone" },
          { key: "owner_street", label: "Street Address" },
          { key: "owner_city", label: "City" },
          { key: "owner_state_province", label: "State/Province" },
          { key: "owner_zip", label: "ZIP/Postal Code" },
          { key: "owner_country", label: "Country" },
          { key: "owner_tax_residency", label: "Tax Residency Country" },
          { key: "owner_local_tax_number", label: "Local Tax ID Number" },
          { key: "owner_direct_100_pct", label: "Direct 100% Owner (SMLLC)" },
          { key: "owner_ultimate_25_pct", label: "Ultimate 25%+ Owner (SMLLC)" },
          { key: "ultimate_owner_name", label: "Ultimate Owner Name" },
          { key: "ultimate_owner_address", label: "Ultimate Owner Address" },
          { key: "ultimate_owner_country", label: "Ultimate Owner Country" },
          { key: "ultimate_owner_tax_id", label: "Ultimate Owner Tax ID" },
          { key: "ownership_structure", label: "Ownership Structure (Corp)" },
          { key: "foreign_owned_25_pct", label: "Foreign Owned 25%+ (Corp)" },
          { key: "foreign_owner_details", label: "Foreign Owner Details (Corp)" },
        ],
      },
      {
        title: "SMLLC Financial Data (Form 5472 / 1120)",
        fields: [
          { key: "formation_costs", label: "Formation Costs (USD)" },
          { key: "bank_contributions", label: "Bank Contributions / Capital (USD)" },
          { key: "distributions_withdrawals", label: "Distributions / Withdrawals (USD)" },
          { key: "personal_expenses", label: "Personal Expenses Paid Through LLC (USD)" },
          { key: "smllc_additional_comments", label: "Additional Comments / Notes" },
        ],
      },
      {
        title: "Related Party Transactions (SMLLC)",
        fields: [
          { key: "has_related_party_transactions", label: "Had Related Party Transactions?" },
          { key: "related_party_transactions", label: "Related Party Transactions (see details below)" },
        ],
      },
      {
        title: "MMLLC Tax Details (Form 1065)",
        fields: [
          // §14 redesign (2026-06-12): members K-1 roster + factual US-activity
          // + explicit compliance answers. Legacy keys kept below — old
          // submissions still render; absent keys are skipped automatically.
          { key: "members_list", label: "Members & Ownership (K-1 data)" },
          { key: "us_office_warehouse", label: "US Office/Warehouse/Physical Location" },
          { key: "us_people_working", label: "People Working Physically in the US" },
          { key: "us_payroll_w2", label: "Ran US Payroll (W-2)" },
          { key: "us_services_performed", label: "Services Physically Performed in the US" },
          { key: "us_rental_property", label: "US Rental Real Estate" },
          { key: "us_inventory_stored", label: "Inventory in US Warehouses (FBA/3PL)" },
          { key: "comp_foreign_accounts", label: "Non-US Bank/Financial Accounts" },
          { key: "comp_foreign_accounts_country", label: "Foreign Account Country" },
          { key: "comp_foreign_accounts_over_10k", label: "Foreign Accounts Ever Over $10,000 (FBAR)" },
          { key: "comp_foreign_subsidiaries", label: "Owns Other Companies" },
          { key: "comp_foreign_trusts", label: "Foreign Trust Transactions" },
          { key: "comp_digital_assets", label: "Digital Assets / Crypto" },
          { key: "comp_digital_assets_scenario", label: "Digital Assets — Scenario" },
          { key: "comp_digital_assets_exchange", label: "Digital Assets — Exchange/Wallet" },
          { key: "comp_digital_assets_1099", label: "Digital Assets — Exchange Sent 1099/1099-DA" },
          { key: "comp_debt_changes", label: "Debt Canceled/Forgiven/Modified" },
          { key: "comp_asset_purchases", label: "Bought/Sold Major Assets" },
          { key: "comp_anything_else", label: "Anything Else (client note)" },
          // Legacy (pre-redesign submissions)
          { key: "prior_year_returns_filed", label: "Prior Year Returns Filed" },
          { key: "financial_statements_sent", label: "Financial Statements Sent" },
          { key: "mmllc_has_payroll", label: "Has Payroll" },
          { key: "mmllc_ownership_change", label: "Ownership Change During Year" },
          { key: "mmllc_foreign_partners", label: "Foreign Partners" },
          { key: "mmllc_assets_over_50k", label: "Total Assets Over $50K" },
          { key: "mmllc_received_1099", label: "Received 1099" },
          { key: "mmllc_issued_1099", label: "Issued 1099" },
          { key: "mmllc_crypto_transactions", label: "Crypto Transactions" },
          { key: "mmllc_real_estate", label: "Real Estate Owned/Used" },
          { key: "mmllc_foreign_bank_accounts", label: "Foreign Bank Accounts" },
          { key: "mmllc_home_office", label: "Home Office Deduction" },
          { key: "mmllc_vehicle_business_use", label: "Vehicle Business Use" },
          { key: "mmllc_health_insurance", label: "Health Insurance" },
          { key: "mmllc_retirement_plan", label: "Retirement Plan" },
          { key: "mmllc_debt_forgiveness", label: "Debt Forgiveness" },
          { key: "mmllc_related_party_trans", label: "Related Party Transactions" },
          { key: "mmllc_additional_info", label: "Additional Notes" },
        ],
      },
      {
        title: "Corp Tax Details (Form 1120)",
        fields: [
          { key: "corp_rental_passive_income", label: "Rental / Passive Income (USD)" },
          { key: "corp_additional_info", label: "Additional Information" },
        ],
      },
      {
        title: "Additional Members (MMLLC)",
        fields: [
          { key: "additional_members", label: "Members (name, ownership %, ITIN/SSN, tax residency, address)" },
        ],
      },
    ],
  },

  formation: {
    bucket: "onboarding-uploads",
    driveSubfolder: "1. Company",
    pdfTitle: "LLC Formation Data Collection",
    filePrefix: "Formation_Data",
    sections: [
      {
        title: "Owner Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "dob", label: "Date of Birth" },
          { key: "citizenship", label: "Citizenship" },
          { key: "passport_number", label: "Passport Number" },
        ],
      },
      {
        title: "LLC Preferences",
        fields: [
          { key: "llc_name_1", label: "LLC Name Option 1" },
          { key: "llc_name_2", label: "LLC Name Option 2" },
          { key: "llc_name_3", label: "LLC Name Option 3" },
          { key: "business_purpose", label: "Business Purpose" },
        ],
      },
      {
        title: "Address",
        fields: [
          { key: "street", label: "Street" },
          { key: "city", label: "City" },
          { key: "state_province", label: "State/Province" },
          { key: "zip", label: "ZIP" },
          { key: "country", label: "Country" },
        ],
      },
    ],
  },

  onboarding: {
    bucket: "onboarding-uploads",
    driveSubfolder: "1. Company",
    pdfTitle: "Client Onboarding Data Collection",
    filePrefix: "Onboarding_Data",
    sections: [
      {
        title: "Owner Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "dob", label: "Date of Birth" },
          { key: "citizenship", label: "Citizenship" },
        ],
      },
      {
        title: "LLC Information",
        fields: [
          { key: "llc_name", label: "LLC Name" },
          { key: "ein_number", label: "EIN" },
          { key: "state_of_formation", label: "State" },
          { key: "formation_date", label: "Formation Date" },
          { key: "registered_agent", label: "Registered Agent" },
        ],
      },
    ],
  },

  itin: {
    bucket: "onboarding-uploads",
    driveSubfolder: "ITIN",
    pdfTitle: "ITIN Application Data Collection",
    filePrefix: "ITIN_Data",
    sections: [
      {
        title: "Personal Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "dob", label: "Date of Birth" },
          { key: "country_of_birth", label: "Country of Birth" },
          { key: "city_of_birth", label: "City of Birth" },
          { key: "gender", label: "Gender" },
          { key: "citizenship", label: "Citizenship" },
        ],
      },
      {
        title: "Foreign Address",
        fields: [
          { key: "foreign_street", label: "Street" },
          { key: "foreign_city", label: "City" },
          { key: "foreign_state_province", label: "State/Province" },
          { key: "foreign_zip", label: "ZIP" },
          { key: "foreign_country", label: "Country" },
          { key: "foreign_tax_id", label: "Foreign Tax ID" },
        ],
      },
      {
        title: "Passport & Visa",
        fields: [
          { key: "passport_number", label: "Passport Number" },
          { key: "passport_country", label: "Passport Country" },
          { key: "passport_expiry", label: "Passport Expiry" },
          { key: "us_visa_type", label: "US Visa Type" },
          { key: "us_visa_number", label: "US Visa Number" },
          { key: "us_entry_date", label: "US Entry Date" },
          { key: "has_previous_itin", label: "Previous ITIN" },
          { key: "previous_itin", label: "Previous ITIN Number" },
        ],
      },
    ],
  },

  banking: {
    bucket: "banking-uploads",
    driveSubfolder: "4. Banking",
    pdfTitle: "Banking Application Data",
    filePrefix: "Banking_Data",
    sections: [
      {
        title: "Owner Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "dob", label: "Date of Birth" },
          { key: "citizenship", label: "Citizenship" },
          { key: "ssn_itin", label: "SSN/ITIN" },
        ],
      },
      {
        title: "Business Information",
        fields: [
          { key: "llc_name", label: "LLC Name" },
          { key: "ein_number", label: "EIN" },
          { key: "business_type", label: "Business Type" },
          { key: "business_description", label: "Business Description" },
          { key: "website_url", label: "Website" },
          { key: "expected_monthly_revenue", label: "Expected Monthly Revenue" },
        ],
      },
    ],
  },

  closure: {
    bucket: "onboarding-uploads",
    driveSubfolder: "1. Company",
    pdfTitle: "LLC Closure Data Collection",
    filePrefix: "Closure_Data",
    sections: [
      {
        title: "Owner Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
        ],
      },
      {
        title: "LLC to Close",
        fields: [
          { key: "llc_name", label: "LLC Name" },
          { key: "ein_number", label: "EIN" },
          { key: "state_of_formation", label: "State" },
          { key: "formation_year", label: "Formation Year" },
          { key: "registered_agent", label: "Current Registered Agent" },
          { key: "last_tax_return_year", label: "Last Tax Return Filed" },
          { key: "outstanding_taxes", label: "Outstanding Taxes/Fees" },
        ],
      },
    ],
  },

  banking_payset: {
    bucket: "onboarding-uploads",
    driveSubfolder: "4. Banking",
    pdfTitle: "Banking Application — Payset (EUR IBAN)",
    filePrefix: "Banking_Payset",
    sections: [
      {
        title: "Personal Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "personal_street", label: "Street Address" },
          { key: "personal_city", label: "City" },
          { key: "personal_state_province", label: "State/Province" },
          { key: "personal_zip", label: "ZIP/Postal Code" },
          { key: "personal_country", label: "Country of Residence" },
        ],
      },
      {
        title: "Business Information",
        fields: [
          { key: "business_name", label: "Business Name (LLC)" },
          { key: "business_street", label: "Business Address" },
          { key: "business_city", label: "Business City" },
          { key: "business_state_province", label: "Business State/Province" },
          { key: "business_zip", label: "Business ZIP" },
          { key: "business_country", label: "Business Country" },
          { key: "business_type", label: "Business Type" },
          { key: "us_physical_presence", label: "US Physical Presence" },
          { key: "business_model", label: "Business Model" },
          { key: "products_services", label: "Products/Services" },
          { key: "operating_countries", label: "Operating Countries" },
          { key: "website_url", label: "Website" },
          { key: "phone", label: "Phone" },
          { key: "email", label: "Email" },
          { key: "crypto_transactions", label: "Cryptocurrency Transactions" },
          { key: "monthly_volume", label: "Expected Monthly Volume (EUR)" },
        ],
      },
    ],
  },

  banking_relay: {
    bucket: "onboarding-uploads",
    driveSubfolder: "4. Banking",
    pdfTitle: "Banking Application — Relay (USD Business Account)",
    filePrefix: "Banking_Relay",
    sections: [
      {
        title: "Business Information",
        fields: [
          { key: "business_name", label: "Business Name (LLC)" },
          { key: "phone", label: "Phone" },
          { key: "email", label: "Email" },
          { key: "ein", label: "EIN Number" },
          { key: "business_description", label: "Business Description" },
          { key: "avg_monthly_revenue", label: "Average Monthly Revenue (USD)" },
          { key: "other_us_bank", label: "Other US Bank Account" },
        ],
      },
      {
        title: "Owner Information",
        fields: [
          { key: "first_name", label: "First Name" },
          { key: "last_name", label: "Last Name" },
          { key: "personal_street", label: "Street Address" },
          { key: "personal_city", label: "City" },
          { key: "personal_state", label: "State/Province" },
          { key: "personal_zip", label: "ZIP/Postal Code" },
          { key: "personal_phone", label: "Personal Phone" },
          { key: "personal_email", label: "Personal Email" },
          { key: "equity_pct", label: "Ownership %" },
          { key: "has_partner", label: "Has Business Partner" },
        ],
      },
      {
        title: "Partner Information",
        fields: [
          { key: "partner_first_name", label: "Partner First Name" },
          { key: "partner_last_name", label: "Partner Last Name" },
          { key: "partner_street", label: "Partner Address" },
          { key: "partner_city", label: "Partner City" },
          { key: "partner_state", label: "Partner State" },
          { key: "partner_zip", label: "Partner ZIP" },
          { key: "partner_phone", label: "Partner Phone" },
          { key: "partner_email", label: "Partner Email" },
          { key: "partner_equity_pct", label: "Partner Ownership %" },
        ],
      },
    ],
  },
}

// ─── Text Sanitizer for WinAnsi PDF fonts ───

/**
 * Replace characters outside the WinAnsi range (U+0000–U+00FF) with ASCII
 * approximations so pdf-lib's StandardFonts don't throw on non-Latin-1 input.
 * Common substitutions (e.g. Maltese ħ→h) are explicit; everything else falls
 * back to "?" so no data is silently lost without a visible marker.
 */
export function sanitizeForPdf(text: string): string {
  return text
    .replace(/[Ħħ]/g, match => match === "Ħ" ? "H" : "h")   // Maltese h-bar
    .replace(/[Ġġ]/g, match => match === "Ġ" ? "G" : "g")   // Maltese g-dot
    .replace(/[Ċċ]/g, match => match === "Ċ" ? "C" : "c")   // Maltese c-dot
    .replace(/[Żż]/g, match => match === "Ż" ? "Z" : "z")   // Maltese z-dot
    .replace(/[^\x00-\xFF]/g, "?")                    // any remaining non-Latin-1
}

// ─── Field-Row Layout Helpers ───

/**
 * Column geometry for label/value rows in the summary PDF.
 * Labels longer than the value column (x=200) used to be overprinted by the
 * value drawn at a fixed x=200 (e.g. "Personal Expenses Paid Through LLC
 * (USD):" is 192pt wide at 9pt bold, so the number landed on top of the label
 * tail — reported unreadable by the accountant on 2026-07-02). Every row must
 * go through valueStartX/wrapByWidth so label and value can never collide.
 */
export const PDF_LAYOUT = {
  /** Right edge of the printable area (page is 612pt wide). */
  rightMargin: 562,
  /** Preferred x where values start — keeps a visually aligned column. */
  valueColumnX: 200,
  /** Minimum horizontal gap between the end of a label and its value. */
  labelValueGap: 8,
  /** Indent for value lines wrapped below their label. */
  wrapIndentX: 60,
  /** If the value would have to start past this x, wrap it below instead. */
  maxValueStartX: 340,
} as const

/** X where a row's value can start without overlapping its label. */
export function valueStartX(labelX: number, labelWidth: number): number {
  return Math.max(PDF_LAYOUT.valueColumnX, labelX + labelWidth + PDF_LAYOUT.labelValueGap)
}

/**
 * Greedy word-wrap by MEASURED width (not character count — character counts
 * under-estimate wide glyphs). Words wider than maxWidth are hard-broken so
 * no line can ever overflow.
 */
export function wrapByWidth(
  text: string,
  maxWidth: number,
  widthOf: (s: string) => number
): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // Hard-break words that alone exceed maxWidth
    if (widthOf(word) > maxWidth) {
      if (line) { lines.push(line); line = "" }
      let chunk = ""
      for (const ch of word) {
        if (widthOf(chunk + ch) > maxWidth && chunk) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      line = chunk
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (widthOf(candidate) > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// ─── Generate Summary PDF ───

export async function generateFormSummaryPDF(
  config: FormDriveConfig,
  data: Record<string, unknown>,
  meta: { token: string; submittedAt: string; companyName?: string; uploadCount: number }
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const blue = rgb(0.12, 0.23, 0.37)
  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)
  const green = rgb(0.02, 0.59, 0.41)

  let page = pdf.addPage([612, 792])
  let y = 740

  function ensureSpace(needed: number) {
    if (y < needed + 60) {
      page = pdf.addPage([612, 792])
      y = 740
    }
  }

  /**
   * Draw one "Label:  value" row with collision-proof layout: the value
   * starts after the measured label (aligned at x=200 when it fits) and
   * wraps below the label when it can't fit beside it. All four field
   * render sites MUST use this — never drawText a value at a hardcoded x.
   */
  function drawFieldRow(
    label: string,
    display: string,
    labelX: number,
    opts?: { valueSize?: number; rowAdvance?: number }
  ) {
    const valueSize = opts?.valueSize ?? 10
    const rowAdvance = opts?.rowAdvance ?? 16
    // Collapse newlines/tabs: values render as a single flowing string (the
    // wrap path always did this via split(/\s+/); measuring raw control
    // chars would throw in pdf-lib's WinAnsi encoder).
    display = display.replace(/\s+/g, " ").trim()
    ensureSpace(20)
    page.drawText(label, { x: labelX, y, size: 9, font: fontBold, color: gray })
    const vx = valueStartX(labelX, fontBold.widthOfTextAtSize(label, 9))
    if (
      vx <= PDF_LAYOUT.maxValueStartX &&
      font.widthOfTextAtSize(display, valueSize) <= PDF_LAYOUT.rightMargin - vx
    ) {
      page.drawText(display, { x: vx, y, size: valueSize, font, color: black })
      y -= rowAdvance
      return
    }
    // Value doesn't fit beside the label — wrap it on its own line(s) below.
    y -= 14
    const maxW = PDF_LAYOUT.rightMargin - PDF_LAYOUT.wrapIndentX
    for (const line of wrapByWidth(display, maxW, s => font.widthOfTextAtSize(s, 9))) {
      ensureSpace(14)
      page.drawText(line, { x: PDF_LAYOUT.wrapIndentX, y, size: 9, font, color: black })
      y -= 12
    }
    y -= 4
  }

  // Title
  page.drawText(config.pdfTitle, { x: 50, y, size: 18, font: fontBold, color: blue })
  y -= 20
  if (meta.companyName) {
    page.drawText(sanitizeForPdf(meta.companyName), { x: 50, y, size: 14, font: fontBold, color: black })
    y -= 16
  }
  page.drawText(`Form: ${meta.token} | Submitted: ${meta.submittedAt}`, { x: 50, y, size: 9, font, color: gray })
  y -= 24

  // Sections
  for (const section of config.sections) {
    ensureSpace(40)
    y -= 4
    page.drawText(section.title, { x: 50, y, size: 12, font: fontBold, color: blue })
    y -= 3
    page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 0.5, color: blue })
    y -= 14

    for (const field of section.fields) {
      ensureSpace(20)
      const val = data[field.key]
      if (val === undefined || val === null || val === "") continue

      // ── Special handling: render array of members/objects as formatted sub-sections ──
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
        page.drawText(field.label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
        y -= 16

        const memberFieldLabels: Record<string, string> = {
          member_name: "Name",
          member_kind: "Person or Company",
          member_citizenship: "Citizenship",
          member_residence_country: "Country of Residence",
          member_itin_status: "ITIN Status",
          member_itin: "ITIN",
          member_company_owner: "Real Person Behind the Company",
          member_foreign_tax_id: "Home-Country Tax ID",
          member_ownership_pct: "Ownership %",
          member_itin_ssn: "ITIN / SSN",
          member_tax_residency: "Tax Residency",
          member_address: "Address",
          rpt_company_name: "Company Name",
          rpt_address: "Address",
          rpt_country: "Country",
          rpt_vat_number: "VAT Number",
          rpt_amount: "Amount",
          rpt_direction: "Direction",
          rpt_type: "Transaction Type",
          rpt_description: "Description",
        }

        // Human-readable labels for stored option codes (the wizard stores values
        // like "to_llc" / "services"; show the accountant the readable text).
        const repeaterValueLabels: Record<string, Record<string, string>> = {
          rpt_direction: {
            to_llc: "Money received FROM this party",
            from_llc: "Money paid TO this party",
          },
          rpt_type: {
            sale_goods: "Sale of goods / products",
            services: "Services or consulting fee",
            rent: "Rent (property / equipment)",
            royalties: "Royalties or license fees",
            interest: "Interest",
            loan: "Loan (money lent or borrowed)",
            capital: "Capital contribution / distribution",
            management_fee: "Management or commission fee",
            reimbursement: "Reimbursement of expenses",
            other: "Other",
          },
        }

        for (let mi = 0; mi < val.length; mi++) {
          const item = val[mi] as Record<string, unknown>
          ensureSpace(30)
          // Sub-header: "Member 1", "Member 2", etc. or "Transaction 1", etc.
          const isRpt = Object.keys(item).some(k => k.startsWith("rpt_"))
          const subLabel = isRpt ? `Transaction ${mi + 1}` : `Member ${mi + 1}`
          page.drawText(subLabel, { x: 60, y, size: 10, font: fontBold, color: black })
          y -= 14

          for (const [itemKey, itemVal] of Object.entries(item)) {
            if (itemVal === undefined || itemVal === null || itemVal === "") continue
            const itemLabel = memberFieldLabels[itemKey] || itemKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            const mappedValue = repeaterValueLabels[itemKey]?.[String(itemVal)]
            const itemDisplay = sanitizeForPdf(mappedValue ?? (typeof itemVal === "boolean" ? (itemVal ? "Yes" : "No") : String(itemVal)))
            drawFieldRow(`${itemLabel}:`, itemDisplay, 70, { rowAdvance: 14 })
          }
          y -= 6
        }
        continue
      }

      // Format scalar value
      let display: string
      if (typeof val === "boolean") {
        display = val ? "Yes" : "No"
      } else if (Array.isArray(val)) {
        display = val.join(", ")
      } else {
        display = String(val)
      }

      drawFieldRow(field.label + ":", sanitizeForPdf(display), 50)
    }
    y -= 8
  }

  // Handle arrays/objects not covered by sections (e.g., additional_members)
  const sectionKeys = new Set(config.sections.flatMap(s => s.fields.map(f => f.key)))
  const extraKeys = Object.keys(data).filter(k => !sectionKeys.has(k) && data[k] !== null && data[k] !== undefined && data[k] !== "")

  if (extraKeys.length > 0) {
    ensureSpace(40)
    y -= 4
    page.drawText("Additional Information", { x: 50, y, size: 12, font: fontBold, color: blue })
    y -= 3
    page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 0.5, color: blue })
    y -= 14

    for (const key of extraKeys) {
      ensureSpace(20)
      const val = data[key]

      // Array of objects — render as sub-sections (same as section fields)
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
        const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        page.drawText(label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
        y -= 16
        for (let mi = 0; mi < val.length; mi++) {
          const item = val[mi] as Record<string, unknown>
          ensureSpace(30)
          page.drawText(`Item ${mi + 1}`, { x: 60, y, size: 10, font: fontBold, color: black })
          y -= 14
          for (const [itemKey, itemVal] of Object.entries(item)) {
            if (itemVal === undefined || itemVal === null || itemVal === "") continue
            const itemLabel = itemKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            drawFieldRow(`${itemLabel}:`, sanitizeForPdf(String(itemVal)), 70, { rowAdvance: 14 })
          }
          y -= 6
        }
        continue
      }

      let display: string
      if (typeof val === "boolean") display = val ? "Yes" : "No"
      else if (Array.isArray(val)) display = val.join(", ")
      else if (typeof val === "object" && val !== null) display = JSON.stringify(val, null, 2)
      else display = String(val)

      const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      drawFieldRow(label + ":", sanitizeForPdf(display), 50)
    }
  }

  // Uploads count
  if (meta.uploadCount > 0) {
    ensureSpace(30)
    y -= 8
    page.drawText(`Uploaded Documents: ${meta.uploadCount} file(s)`, { x: 50, y, size: 10, font: fontBold, color: green })
    y -= 16
  }

  // Footer on last page
  const lastPage = pdf.getPages()[pdf.getPageCount() - 1]
  lastPage.drawText("Tony Durante LLC — 10225 Ulmerton Rd, Suite 3D, Largo, FL 33771 | +1 (727) 452-1093", {
    x: 50, y: 30, size: 8, font, color: gray,
  })

  return pdf.save()
}

// ─── Copy Uploads to Drive ───

export async function copyUploadsToDrive(
  uploadPaths: string[],
  bucket: string,
  targetFolderId: string,
  fileMapping?: Record<string, string>, // optional: map category prefixes to Drive subfolders
  opts?: {
    existingNames?: Map<string, string> | null // optional pre-fetched folderFileNameMap for targetFolderId
    // Per-file bucket resolver (2026-07-24, Drive-reliability). A single tax
    // submission can now carry files from TWO buckets: portal-wizard uploads in
    // "onboarding-uploads" and legacy EXTERNAL-form uploads (e.g. Carasso's EIN
    // letter, path "carasso-consulting-llc-2025/…") in "tax-form-uploads". With
    // one fixed bucket the external file downloads from the wrong bucket → 0
    // files copied. When provided, this picks the bucket per path; else `bucket`.
    resolveBucket?: (path: string) => string
  }
): Promise<{ copied: string[]; failed: string[]; skipped: string[] }> {
  const { uploadBinaryToDrive, folderFileNameMap } = await import("@/lib/google-drive")
  const copied: string[] = []
  const failed: string[] = []
  const skipped: string[] = []

  // Duplicate-upload guard (LT Program incident, 2026-07-07): a re-run of the
  // same job (or a duplicate submission) must not pile a second copy of an
  // already-copied file into the folder. Upload file names embed a per-upload
  // hash segment, so name-equality means the same stored object — skipping is
  // lossless. A null map means the listing failed: default to uploading
  // (worst case a stray duplicate, never a silently missing file).
  const namesByFolder = new Map<string, Map<string, string> | null>()
  if (opts?.existingNames !== undefined) namesByFolder.set(targetFolderId, opts.existingNames)
  const existingNamesFor = async (folderId: string): Promise<Map<string, string> | null> => {
    if (!namesByFolder.has(folderId)) namesByFolder.set(folderId, await folderFileNameMap(folderId))
    return namesByFolder.get(folderId) ?? null
  }

  const MAX_RETRIES = 3
  const RETRY_DELAYS = [0, 1000, 3000] // immediate, 1s, 3s

  for (const path of uploadPaths) {
    const fileName = path.split("/").pop() || "document.pdf"

    // Destination depends only on the file name — resolve it up front so the
    // skip check runs before the (potentially retried) download.
    let destFolder = targetFolderId
    if (fileMapping) {
      for (const [prefix, folderId] of Object.entries(fileMapping)) {
        if (fileName.toLowerCase().startsWith(prefix.toLowerCase())) {
          destFolder = folderId
          break
        }
      }
    }

    const existing = await existingNamesFor(destFolder)
    if (existing?.has(fileName)) {
      skipped.push(fileName)
      continue
    }

    const fileBucket = opts?.resolveBucket ? opts.resolveBucket(path) : bucket

    let downloaded = false

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (RETRY_DELAYS[attempt] > 0) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
        }

        const { data: fileData, error: dlError } = await supabaseAdmin.storage
          .from(fileBucket)
          .download(path)

        if (dlError) {
          console.warn(`[copyUploadsToDrive] Attempt ${attempt + 1}/${MAX_RETRIES} failed for ${fileBucket}/${path}: ${dlError.message}`)
          if (attempt === MAX_RETRIES - 1) {
            failed.push(`${fileName} (download error after ${MAX_RETRIES} attempts: ${dlError.message})`)
          }
          continue
        }

        if (!fileData || fileData.size === 0) {
          console.warn(`[copyUploadsToDrive] Attempt ${attempt + 1}/${MAX_RETRIES} empty for ${bucket}/${path} (size: ${fileData?.size ?? 'null'})`)
          if (attempt === MAX_RETRIES - 1) {
            failed.push(`${fileName} (empty after ${MAX_RETRIES} attempts)`)
          }
          continue
        }

        // Download succeeded — upload to Drive
        const buf = Buffer.from(await fileData.arrayBuffer())
        const mimeType = fileData.type || "application/octet-stream"

        await uploadBinaryToDrive(fileName, buf, mimeType, destFolder)
        copied.push(fileName)
        downloaded = true
        break
      } catch (e) {
        console.warn(`[copyUploadsToDrive] Attempt ${attempt + 1}/${MAX_RETRIES} exception for ${path}: ${e instanceof Error ? e.message : String(e)}`)
        if (attempt === MAX_RETRIES - 1) {
          failed.push(`${fileName}: ${e instanceof Error ? e.message : String(e)} (after ${MAX_RETRIES} attempts)`)
        }
      }
    }

    if (!downloaded && !failed.some(f => f.startsWith(fileName))) {
      failed.push(`${fileName} (failed after ${MAX_RETRIES} attempts)`)
    }
  }

  return { copied, failed, skipped }
}

// ─── Tax-return payload normalization for the summary PDF ───

/**
 * Alias keys the portal tax wizard stores alongside the canonical section
 * keys (same value under several names). The "Additional Information"
 * section used to dump every alias as its own row (Ein / Llc Ein / Email /
 * Personal Email / …), burying the real extra data in noise. An alias row
 * is skipped ONLY when the canonical key holds the exact same value — if
 * they ever diverge, both are shown (divergence is signal, never hide it).
 */
const TAX_ALIAS_OF: Record<string, string> = {
  ein: "ein_number",
  llc_ein: "ein_number",
  email: "owner_email",
  personal_email: "owner_email",
  phone: "owner_phone",
  personal_phone: "owner_phone",
  first_name: "owner_first_name",
  last_name: "owner_last_name",
  company_name: "llc_name",
  business_name: "llc_name",
  personal_country: "owner_country",
  formation_date: "date_of_incorporation",
  state_of_formation: "state_of_incorporation",
}

/**
 * Normalize a portal tax-wizard payload for the accountant summary PDF:
 *
 * 1. Fold FLATTENED repeater keys (member_N_…, related_party_transactions_N_rpt_…)
 *    into the arrays the PDF's object-array renderer understands
 *    (members_list → "Member N" blocks; related_party_transactions →
 *    "Transaction N" blocks with readable direction/type labels instead of
 *    raw codes like "from_llc"/"capital"). The count key is authoritative
 *    (removed rows leave orphaned higher-index keys behind). After a
 *    successful fold the flattened keys + count are dropped so they don't
 *    duplicate into "Additional Information". If a fold produces nothing,
 *    the raw keys are kept — never hide data.
 * 2. Drop alias keys whose canonical twin carries the identical value
 *    (see TAX_ALIAS_OF).
 *
 * Pure function — returns a new object, never mutates the input.
 */
export function normalizeTaxPayloadForPdf(
  data: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data }

  // ── Fold members (member_count + member_N_member_*) ──
  if (out.member_count !== undefined) {
    const count = Number(out.member_count) || 0
    const membersList: Record<string, unknown>[] = []
    for (let i = 0; i < count; i++) {
      const get = (k: string) => out[`member_${i}_${k}`]
      if (!get("member_first_name") && !get("member_last_name") && !get("member_company_name")) continue
      membersList.push({
        member_name: get("member_company_name") || `${get("member_first_name") ?? ""} ${get("member_last_name") ?? ""}`.trim(),
        member_kind: get("member_type"),
        member_citizenship: get("member_citizenship"),
        member_residence_country: get("member_residence_country"),
        member_address: [get("member_street"), get("member_city"), get("member_zip")].filter(Boolean).join(", "),
        member_itin_status: get("member_itin_status"),
        member_itin: get("member_itin"),
        member_company_owner: get("member_company_owner"),
        member_foreign_tax_id: get("member_foreign_tax_id"),
        member_ownership_pct: get("member_ownership_pct"),
      })
    }
    if (membersList.length > 0) {
      out.members_list = membersList
      delete out.member_count
      for (const k of Object.keys(out)) {
        if (/^member_\d+_/.test(k)) delete out[k]
      }
    }
  }

  // ── Fold related-party transactions (…_count + …_N_rpt_*) ──
  if (out.related_party_transactions_count !== undefined) {
    const count = Number(out.related_party_transactions_count) || 0
    const transactions: Record<string, unknown>[] = []
    for (let i = 0; i < count; i++) {
      const get = (k: string) => out[`related_party_transactions_${i}_${k}`]
      if (!get("rpt_company_name") && !get("rpt_description") && !get("rpt_amount")) continue
      transactions.push({
        rpt_company_name: get("rpt_company_name"),
        rpt_address: get("rpt_address"),
        rpt_country: get("rpt_country"),
        rpt_vat_number: get("rpt_vat_number"),
        rpt_amount: get("rpt_amount"),
        rpt_direction: get("rpt_direction"),
        rpt_type: get("rpt_type"),
        rpt_description: get("rpt_description"),
      })
    }
    if (transactions.length > 0) {
      out.related_party_transactions = transactions
      delete out.related_party_transactions_count
      for (const k of Object.keys(out)) {
        if (/^related_party_transactions_\d+_/.test(k)) delete out[k]
      }
    }
  }

  // ── Drop alias keys that exactly duplicate their canonical twin ──
  for (const [alias, canonical] of Object.entries(TAX_ALIAS_OF)) {
    if (
      alias in out &&
      out[canonical] !== undefined && out[canonical] !== null && out[canonical] !== "" &&
      String(out[alias]) === String(out[canonical])
    ) {
      delete out[alias]
    }
  }

  return out
}

// ─── Full Save-to-Drive Pipeline ───

export async function saveFormToDrive(
  formType: string,
  submittedData: Record<string, unknown>,
  uploadPaths: string[],
  driveFolderId: string,
  meta: { token: string; submittedAt: string; companyName?: string; year?: string | number },
  /**
   * Optional override for the Supabase Storage bucket the uploaded files live
   * in. The per-form-type config default (`config.bucket`) is the bucket the
   * EXTERNAL public forms upload to (e.g. tax → "tax-form-uploads"). The PORTAL
   * wizard uploads ALL file fields to the shared "onboarding-uploads" bucket
   * regardless of wizard type (see app/api/portal/wizard-upload[-url]/route.ts).
   * So a portal tax submission's files are in "onboarding-uploads", NOT the
   * config default — without this override copyUploadsToDrive downloaded from
   * the wrong bucket and EVERY file failed (0 files copied to Drive), which in
   * turn left step 7's bank-statement parse with nothing to read and produced
   * no P&L/Balance Sheet. Pass the bucket the files were actually uploaded to.
   */
  opts?: { bucket?: string; resolveBucket?: (path: string) => string },
): Promise<{ summaryFileId: string | null; copied: string[]; failed: string[]; skipped: string[]; errors: string[] }> {
  // Tax wizard payloads arrive with flattened repeater keys and alias
  // duplicates — normalize them for the accountant PDF (fold member/RPT
  // repeaters into renderable arrays, drop exact-duplicate alias keys).
  if (formType === "tax_return") {
    submittedData = normalizeTaxPayloadForPdf(submittedData)
  }
  const config = FORM_CONFIGS[formType]
  if (!config) {
    return { summaryFileId: null, copied: [], failed: [], skipped: [], errors: [`Unknown form type: ${formType}`] }
  }
  const bucket = opts?.bucket || config.bucket

  const { listFolder, createFolder, uploadBinaryToDriveUpsert, folderFileNameMap } = await import("@/lib/google-drive")
  const errors: string[] = []

  // Find or create subfolder.
  // ABORT-ON-UNRESOLVED (2026-07-24, Drive-reliability): if the target
  // subfolder / year folder cannot be resolved, we MUST NOT continue — the old
  // code fell through with targetFolderId still = the account ROOT and dumped
  // the PDF + every file there while still returning a truthy summaryFileId,
  // reporting "ok" while 3.Tax/{year} stayed empty (a silent misfile). Return
  // with errors and NO uploads so the durable archive job retries instead.
  let targetFolderId = driveFolderId
  try {
    const contents = await listFolder(driveFolderId)
    const existing = contents?.files?.find(
      (f: { name: string; mimeType: string }) =>
        f.name === config.driveSubfolder && f.mimeType === "application/vnd.google-apps.folder"
    )
    if (existing) {
      targetFolderId = existing.id
    } else {
      const newFolder = await createFolder(driveFolderId, config.driveSubfolder)
      targetFolderId = newFolder.id
    }

    // For tax_return: create year subfolder inside "3. Tax/"
    if (formType === "tax_return" && meta.year) {
      const yearStr = String(meta.year)
      const yearContents = await listFolder(targetFolderId)
      const yearFolder = yearContents?.files?.find(
        (f: { name: string; mimeType: string }) =>
          f.name === yearStr && f.mimeType === "application/vnd.google-apps.folder"
      )
      if (yearFolder) {
        targetFolderId = yearFolder.id
      } else {
        const newYear = await createFolder(targetFolderId, yearStr)
        targetFolderId = newYear.id
      }
    }
  } catch (e) {
    // Do NOT fall through to the account root — abort the whole archival.
    return {
      summaryFileId: null,
      copied: [],
      failed: [],
      skipped: [],
      errors: [`Subfolder unresolved (aborted to avoid misfiling to account root): ${e instanceof Error ? e.message : String(e)}`],
    }
  }

  // One listing of the target folder feeds both the summary-PDF upsert and
  // the upload skip-guard below (LT Program duplicate incident, 2026-07-07). If
  // the listing itself fails, ABORT — a null map turns the stable-name UPSERT
  // into a blind CREATE (duplicate PDFs/files on a retry). Better to fail and
  // let the durable job retry with a good listing.
  const existingNames = await folderFileNameMap(targetFolderId)
  if (!existingNames) {
    return {
      summaryFileId: null,
      copied: [],
      failed: [],
      skipped: [],
      errors: ["Target folder listing failed (aborted to avoid duplicate uploads on retry)"],
    }
  }

  // Generate summary PDF. The file name is stable across runs, so this is an
  // UPSERT: a re-run or resubmission refreshes the one existing PDF in place
  // instead of piling up copies.
  let summaryFileId: string | null = null
  try {
    const summaryPdf = await generateFormSummaryPDF(config, submittedData, {
      ...meta,
      uploadCount: uploadPaths.length,
    })
    const slug = (meta.companyName || meta.token).replace(/\s+/g, "_")
    const result = await uploadBinaryToDriveUpsert(
      `${config.filePrefix}_${slug}.pdf`,
      Buffer.from(summaryPdf),
      "application/pdf",
      targetFolderId,
      existingNames
    )
    summaryFileId = result.id
  } catch (e) {
    errors.push(`Summary PDF error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Copy uploaded files (bucket may be overridden — see opts.bucket docblock).
  // Already-present file names are skipped, not re-uploaded.
  const { copied, failed, skipped } = await copyUploadsToDrive(
    uploadPaths,
    bucket,
    targetFolderId,
    undefined,
    { existingNames, resolveBucket: opts?.resolveBucket }
  )

  return { summaryFileId, copied, failed, skipped, errors }
}
