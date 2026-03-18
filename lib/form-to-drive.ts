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
    pdfTitle: "Tax Return Data Collection",
    filePrefix: "Tax_Data",
    sections: [
      {
        title: "Company Information",
        fields: [
          { key: "llc_name", label: "LLC Name" },
          { key: "ein_number", label: "EIN" },
          { key: "state_of_incorporation", label: "State" },
          { key: "date_of_incorporation", label: "Formation Date" },
          { key: "principal_product_service", label: "Principal Product/Service" },
          { key: "us_business_activities", label: "US Business Activities" },
          { key: "website_url", label: "Website" },
        ],
      },
      {
        title: "Owner Information",
        fields: [
          { key: "owner_first_name", label: "First Name" },
          { key: "owner_last_name", label: "Last Name" },
          { key: "owner_email", label: "Email" },
          { key: "owner_phone", label: "Phone" },
          { key: "owner_street", label: "Address" },
          { key: "owner_city", label: "City" },
          { key: "owner_state_province", label: "State/Province" },
          { key: "owner_zip", label: "ZIP" },
          { key: "owner_country", label: "Country" },
          { key: "owner_tax_residency", label: "Tax Residency" },
          { key: "owner_local_tax_number", label: "Local Tax Number" },
        ],
      },
      {
        title: "Tax Details",
        fields: [
          { key: "prior_year_returns_filed", label: "Prior Year Returns Filed" },
          { key: "financial_statements_sent", label: "Financial Statements Sent" },
          { key: "mmllc_foreign_partners", label: "Foreign Partners" },
          { key: "mmllc_foreign_bank_accounts", label: "Foreign Bank Accounts" },
          { key: "mmllc_assets_over_50k", label: "Assets Over $50K" },
          { key: "mmllc_crypto_transactions", label: "Crypto Transactions" },
          { key: "mmllc_has_payroll", label: "Has Payroll" },
          { key: "mmllc_issued_1099", label: "Issued 1099" },
          { key: "mmllc_received_1099", label: "Received 1099" },
          { key: "mmllc_real_estate", label: "Real Estate" },
          { key: "mmllc_home_office", label: "Home Office" },
          { key: "mmllc_vehicle_business_use", label: "Vehicle Business Use" },
          { key: "mmllc_health_insurance", label: "Health Insurance" },
          { key: "mmllc_retirement_plan", label: "Retirement Plan" },
          { key: "mmllc_debt_forgiveness", label: "Debt Forgiveness" },
          { key: "mmllc_related_party_trans", label: "Related Party Transactions" },
          { key: "mmllc_ownership_change", label: "Ownership Change" },
          { key: "mmllc_additional_info", label: "Additional Notes" },
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
    bucket: "onboarding-uploads",
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

      // Format value
      let display: string
      if (typeof val === "boolean") {
        display = val ? "Yes" : "No"
      } else if (Array.isArray(val)) {
        // Handle arrays (e.g., additional_members)
        display = JSON.stringify(val, null, 2)
      } else {
        display = String(val)
      }

      // Truncate long values
      if (display.length > 100) display = display.substring(0, 97) + "..."

      page.drawText(field.label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
      page.drawText(display, { x: 200, y, size: 10, font, color: black })
      y -= 16
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
      let display: string
      if (typeof val === "boolean") display = val ? "Yes" : "No"
      else if (typeof val === "object") display = JSON.stringify(val)
      else display = String(val)

      if (display.length > 80) display = display.substring(0, 77) + "..."

      const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      page.drawText(label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
      page.drawText(display, { x: 200, y, size: 10, font, color: black })
      y -= 16
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
  meta: { token: string; submittedAt: string; companyName?: string }
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
