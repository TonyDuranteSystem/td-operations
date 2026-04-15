/**
 * ITIN Application Data Summary PDF
 * Generates a PDF with all submitted client data from the ITIN form.
 * Saved to Drive as a record of what was collected.
 */

import { PDFDocument, rgb } from "pdf-lib"
import { embedUnicodeFonts } from "./unicode-fonts"

export interface ITINSummaryData {
  // Personal
  first_name: string
  last_name: string
  name_at_birth?: string
  email: string
  phone: string
  dob: string
  country_of_birth: string
  city_of_birth: string
  gender: string
  citizenship: string
  // Foreign address
  foreign_street: string
  foreign_city: string
  foreign_state_province?: string
  foreign_zip: string
  foreign_country: string
  foreign_tax_id?: string
  // US entry
  us_visa_type?: string
  us_visa_number?: string
  us_entry_date?: string
  // Passport
  passport_number: string
  passport_country: string
  passport_expiry: string
  // Previous ITIN
  has_previous_itin: string
  previous_itin?: string
  // Metadata
  submitted_at: string
  token: string
  upload_count: number
}

export async function generateITINSummaryPDF(data: ITINSummaryData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792]) // US Letter
  const { regular: font, bold: fontBold } = await embedUnicodeFonts(pdf)

  const blue = rgb(0.12, 0.23, 0.37) // #1e3a5f
  const black = rgb(0, 0, 0)
  const gray = rgb(0.4, 0.4, 0.4)

  let y = 740

  function drawTitle(text: string) {
    page.drawText(text, { x: 50, y, size: 18, font: fontBold, color: blue })
    y -= 24
  }

  function drawSection(text: string) {
    y -= 8
    page.drawText(text, { x: 50, y, size: 12, font: fontBold, color: blue })
    y -= 4
    page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 0.5, color: blue })
    y -= 16
  }

  function drawField(label: string, value: string | undefined) {
    if (y < 60) {
      // Would need new page — for now just stop
      return
    }
    page.drawText(label + ":", { x: 50, y, size: 9, font: fontBold, color: gray })
    page.drawText(value || "—", { x: 200, y, size: 10, font, color: black })
    y -= 16
  }

  // Header
  drawTitle("ITIN Application — Data Summary")
  page.drawText(`Form: ${data.token}`, { x: 50, y, size: 9, font, color: gray })
  y -= 12
  page.drawText(`Submitted: ${data.submitted_at}`, { x: 50, y, size: 9, font, color: gray })
  y -= 20

  // Personal Information
  drawSection("Personal Information")
  drawField("Full Name", `${data.first_name} ${data.last_name}`)
  if (data.name_at_birth) drawField("Name at Birth", data.name_at_birth)
  drawField("Email", data.email)
  drawField("Phone", data.phone)
  drawField("Date of Birth", data.dob)
  drawField("Country of Birth", data.country_of_birth)
  drawField("City of Birth", data.city_of_birth)
  drawField("Gender", data.gender)
  drawField("Citizenship", data.citizenship)

  // Foreign Address
  drawSection("Foreign Address")
  drawField("Street", data.foreign_street)
  drawField("City", data.foreign_city)
  if (data.foreign_state_province) drawField("State/Province", data.foreign_state_province)
  drawField("ZIP/Postal Code", data.foreign_zip)
  drawField("Country", data.foreign_country)
  if (data.foreign_tax_id) drawField("Foreign Tax ID", data.foreign_tax_id)

  // US Entry Info
  if (data.us_visa_type || data.us_entry_date) {
    drawSection("US Entry Information")
    if (data.us_visa_type) drawField("Visa Type", data.us_visa_type)
    if (data.us_visa_number) drawField("Visa Number", data.us_visa_number)
    if (data.us_entry_date) drawField("Entry Date", data.us_entry_date)
  }

  // Passport
  drawSection("Passport Information")
  drawField("Passport Number", data.passport_number)
  drawField("Country of Issue", data.passport_country)
  drawField("Expiration Date", data.passport_expiry)
  drawField("Previous ITIN", data.has_previous_itin)
  if (data.previous_itin) drawField("Previous ITIN Number", data.previous_itin)

  // Uploads
  drawSection("Uploaded Documents")
  drawField("Passport Copies", `${data.upload_count} file(s) uploaded`)

  // Footer
  y = 40
  page.drawText("Tony Durante LLC — Certified Acceptance Agent (CAA)", {
    x: 50, y, size: 8, font, color: gray,
  })
  page.drawText("10225 Ulmerton Rd, Suite 3D, Largo, FL 33771 | +1 (727) 452-1093", {
    x: 50, y: y - 12, size: 8, font, color: gray,
  })

  return pdf.save()
}
