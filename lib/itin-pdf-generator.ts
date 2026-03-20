/**
 * ITIN PDF Generator — Wrapper for W-7, 1040-NR, and Schedule OI generation
 *
 * Used by:
 * - /api/itin-form-completed (auto-chain, generates on form submission)
 * - itin_prepare_documents MCP tool (manual trigger)
 *
 * Delegates to:
 * - lib/pdf/w7-fill.ts (Form W-7)
 * - lib/pdf/1040nr-fill.ts (Form 1040-NR + Schedule OI)
 */

export async function generateW7Pdf(data: Record<string, unknown>): Promise<Buffer> {
  const { fillW7 } = await import("@/lib/pdf/w7-fill")
  const pdf = await fillW7({
    first_name: String(data.first_name || ""),
    last_name: String(data.last_name || ""),
    name_at_birth: data.name_at_birth ? String(data.name_at_birth) : undefined,
    foreign_street: String(data.foreign_street || ""),
    foreign_city: String(data.foreign_city || ""),
    foreign_state_province: data.foreign_state_province ? String(data.foreign_state_province) : undefined,
    foreign_zip: String(data.foreign_zip || ""),
    foreign_country: String(data.foreign_country || ""),
    dob: String(data.dob || ""),
    country_of_birth: String(data.country_of_birth || ""),
    city_of_birth: String(data.city_of_birth || ""),
    gender: (data.gender as "Male" | "Female") || "Male",
    citizenship: String(data.citizenship || ""),
    foreign_tax_id: data.foreign_tax_id ? String(data.foreign_tax_id) : undefined,
    us_visa_type: data.us_visa_type ? String(data.us_visa_type) : undefined,
    us_visa_number: data.us_visa_number ? String(data.us_visa_number) : undefined,
    us_entry_date: data.us_entry_date ? String(data.us_entry_date) : undefined,
    passport_number: String(data.passport_number || ""),
    passport_country: String(data.passport_country || ""),
    passport_expiry: String(data.passport_expiry || ""),
    has_previous_itin: data.has_previous_itin === "Yes" || data.has_previous_itin === true,
    previous_itin: data.previous_itin ? String(data.previous_itin) : undefined,
  })
  return Buffer.from(pdf)
}

export async function generate1040NRPdf(data: Record<string, unknown>): Promise<Buffer> {
  const { fill1040NR } = await import("@/lib/pdf/1040nr-fill")
  const pdf = await fill1040NR({
    first_name: String(data.first_name || ""),
    last_name: String(data.last_name || ""),
    citizenship: String(data.citizenship || ""),
    foreign_country: String(data.foreign_country || ""),
    foreign_state_province: data.foreign_state_province ? String(data.foreign_state_province) : undefined,
    foreign_zip: data.foreign_zip ? String(data.foreign_zip) : undefined,
    us_visa_type: data.us_visa_type ? String(data.us_visa_type) : undefined,
  })
  return Buffer.from(pdf)
}

export async function generateScheduleOIPdf(data: Record<string, unknown>): Promise<Buffer> {
  const { fillScheduleOI } = await import("@/lib/pdf/1040nr-fill")
  const pdf = await fillScheduleOI({
    first_name: String(data.first_name || ""),
    last_name: String(data.last_name || ""),
    citizenship: String(data.citizenship || ""),
    foreign_country: String(data.foreign_country || ""),
    foreign_state_province: data.foreign_state_province ? String(data.foreign_state_province) : undefined,
    foreign_zip: data.foreign_zip ? String(data.foreign_zip) : undefined,
    us_visa_type: data.us_visa_type ? String(data.us_visa_type) : undefined,
  })
  return Buffer.from(pdf)
}
