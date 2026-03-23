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
          { key: "related_party_transactions", label: "Related Party Transactions (see details below)" },
        ],
      },
      {
        title: "MMLLC Tax Details (Form 1065)",
        fields: [
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

  // Title
  page.drawText(config.pdfTitle, { x: 50, y, size: 18, font: fontBold, color: blue })
  y -= 20
  if (meta.companyName) {
    page.drawText(meta.companyName, { x: 50, y, size: 14, font: fontBold, color: black })
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
          member_ownership_pct: "Ownership %",
          member_itin_ssn: "ITIN / SSN",
          member_tax_residency: "Tax Residency",
          member_address: "Address",
          rpt_company_name: "Company Name",
          rpt_address: "Address",
          rpt_country: "Country",
          rpt_vat_number: "VAT Number",
          rpt_amount: "Amount",
          rpt_description: "Description",
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
            ensureSpace(14)
            const itemLabel = memberFieldLabels[itemKey] || itemKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            const itemDisplay = typeof itemVal === "boolean" ? (itemVal ? "Yes" : "No") : String(itemVal)
            page.drawText(`${itemLabel}:`, { x: 70, y, size: 9, font: fontBold, color: gray })
            page.drawText(itemDisplay, { x: 200, y, size: 10, font, color: black })
            y -= 14
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

      // Wrap long values across multiple lines (never truncate)
      page.drawText(field.label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
      if (display.length <= 60) {
        page.drawText(display, { x: 200, y, size: 10, font, color: black })
        y -= 16
      } else {
        y -= 14
        // Split into lines of ~80 chars
        const words = display.split(/\s+/)
        let line = ""
        for (const word of words) {
          if ((line + " " + word).length > 80 && line.length > 0) {
            ensureSpace(14)
            page.drawText(line.trim(), { x: 60, y, size: 9, font, color: black })
            y -= 12
            line = word
          } else {
            line += " " + word
          }
        }
        if (line.trim()) {
          ensureSpace(14)
          page.drawText(line.trim(), { x: 60, y, size: 9, font, color: black })
          y -= 12
        }
        y -= 4
      }
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
            ensureSpace(14)
            const itemLabel = itemKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            page.drawText(`${itemLabel}:`, { x: 70, y, size: 9, font: fontBold, color: gray })
            page.drawText(String(itemVal), { x: 200, y, size: 10, font, color: black })
            y -= 14
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
      page.drawText(label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
      if (display.length <= 60) {
        page.drawText(display, { x: 200, y, size: 10, font, color: black })
        y -= 16
      } else {
        y -= 14
        const words = display.split(/\s+/)
        let line = ""
        for (const word of words) {
          if ((line + " " + word).length > 80 && line.length > 0) {
            ensureSpace(14)
            page.drawText(line.trim(), { x: 60, y, size: 9, font, color: black })
            y -= 12
            line = word
          } else {
            line += " " + word
          }
        }
        if (line.trim()) {
          ensureSpace(14)
          page.drawText(line.trim(), { x: 60, y, size: 9, font, color: black })
          y -= 12
        }
        y -= 4
      }
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
  fileMapping?: Record<string, string> // optional: map category prefixes to Drive subfolders
): Promise<{ copied: string[]; failed: string[] }> {
  const { uploadBinaryToDrive } = await import("@/lib/google-drive")
  const copied: string[] = []
  const failed: string[] = []

  for (const path of uploadPaths) {
    try {
      const fileName = path.split("/").pop() || "document.pdf"
      const { data: fileData } = await supabaseAdmin.storage
        .from(bucket)
        .download(path)

      if (fileData) {
        const buf = Buffer.from(await fileData.arrayBuffer())
        const mimeType = fileData.type || "application/octet-stream"

        // Determine target folder (default to targetFolderId)
        let destFolder = targetFolderId
        if (fileMapping) {
          for (const [prefix, folderId] of Object.entries(fileMapping)) {
            if (fileName.toLowerCase().startsWith(prefix.toLowerCase())) {
              destFolder = folderId
              break
            }
          }
        }

        await uploadBinaryToDrive(fileName, buf, mimeType, destFolder)
        copied.push(fileName)
      } else {
        failed.push(`${fileName} (empty download)`)
      }
    } catch (e) {
      const fileName = path.split("/").pop() || path
      failed.push(`${fileName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { copied, failed }
}

// ─── Full Save-to-Drive Pipeline ───

export async function saveFormToDrive(
  formType: string,
  submittedData: Record<string, unknown>,
  uploadPaths: string[],
  driveFolderId: string,
  meta: { token: string; submittedAt: string; companyName?: string; year?: string | number }
): Promise<{ summaryFileId: string | null; copied: string[]; failed: string[]; errors: string[] }> {
  const config = FORM_CONFIGS[formType]
  if (!config) {
    return { summaryFileId: null, copied: [], failed: [], errors: [`Unknown form type: ${formType}`] }
  }

  const { listFolder, createFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
  const errors: string[] = []

  // Find or create subfolder
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
    errors.push(`Subfolder error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Generate summary PDF
  let summaryFileId: string | null = null
  try {
    const summaryPdf = await generateFormSummaryPDF(config, submittedData, {
      ...meta,
      uploadCount: uploadPaths.length,
    })
    const slug = (meta.companyName || meta.token).replace(/\s+/g, "_")
    const result = await uploadBinaryToDrive(
      `${config.filePrefix}_${slug}.pdf`,
      Buffer.from(summaryPdf),
      "application/pdf",
      targetFolderId
    )
    summaryFileId = result.id
  } catch (e) {
    errors.push(`Summary PDF error: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Copy uploaded files
  const { copied, failed } = await copyUploadsToDrive(
    uploadPaths,
    config.bucket,
    targetFolderId
  )

  return { summaryFileId, copied, failed, errors }
}
