/**
 * Passport OCR + MRZ parsing.
 *
 * Extracts passport data from OCR text:
 * - Passport number
 * - Expiry date
 * - Date of birth
 * - Nationality
 * - Full name
 *
 * Tries MRZ (Machine Readable Zone) first, then falls back to visual text patterns.
 */

export interface PassportData {
  passportNumber: string | null
  expiryDate: string | null  // YYYY-MM-DD
  dateOfBirth: string | null // YYYY-MM-DD
  nationality: string | null
  fullName: string | null
}

/**
 * Parse passport MRZ from OCR text.
 * MRZ Type 3 (passport): 2 lines, 44 characters each.
 *
 * Line 1: P<ITASICARI<<VALERIO<<<<<<<<<<<<<<<<<<<<<<<
 * Line 2: AB1234567<8ITA0108094M3012315<<<<<<<<<<<<<<06
 *
 * Line 2 breakdown:
 * [0-8]   Passport number (9 chars, < padded)
 * [9]     Check digit for passport number
 * [10-12] Nationality (3-letter code)
 * [13-18] DOB (YYMMDD)
 * [19]    Check digit for DOB
 * [20]    Sex (M/F/<)
 * [21-26] Expiry (YYMMDD)
 * [27]    Check digit for expiry
 */
export function parsePassportFromOcr(ocrText: string): PassportData {
  const result: PassportData = {
    passportNumber: null,
    expiryDate: null,
    dateOfBirth: null,
    nationality: null,
    fullName: null,
  }

  // Try MRZ parsing first
  const mrzResult = parseMRZ(ocrText)
  if (mrzResult) return mrzResult

  // Fallback: try visual text patterns
  return parseVisualText(ocrText) || result
}

function parseMRZ(text: string): PassportData | null {
  // Clean text: remove spaces between MRZ characters, normalize
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Find MRZ lines: look for lines with mostly uppercase + < characters, ~44 chars
  const mrzCandidates = lines.filter(l => {
    const cleaned = l.replace(/\s/g, '')
    return cleaned.length >= 40 && cleaned.length <= 48
      && /^[A-Z0-9<]{40,48}$/.test(cleaned)
  })

  if (mrzCandidates.length < 2) return null

  // Take last 2 matching lines (MRZ is at bottom of passport)
  const line1 = mrzCandidates[mrzCandidates.length - 2].replace(/\s/g, '')
  const line2 = mrzCandidates[mrzCandidates.length - 1].replace(/\s/g, '')

  // Validate line 1 starts with P
  if (!line1.startsWith('P')) return null

  // Parse line 1: name
  const nameSection = line1.slice(5) // skip P<XXX
  const nameParts = nameSection.split('<<').filter(Boolean)
  const surname = (nameParts[0] || '').replace(/</g, ' ').trim()
  const givenNames = (nameParts[1] || '').replace(/</g, ' ').trim()
  const fullName = givenNames ? `${givenNames} ${surname}` : surname

  // Parse line 2
  const passportNumber = line2.slice(0, 9).replace(/</g, '').trim()
  const nationalityCode = line2.slice(10, 13).replace(/</g, '')
  const dobRaw = line2.slice(13, 19)
  const expiryRaw = line2.slice(21, 27)

  return {
    passportNumber: passportNumber || null,
    expiryDate: parseMrzDate(expiryRaw),
    dateOfBirth: parseMrzDate(dobRaw),
    nationality: nationalityCode || null,
    fullName: fullName || null,
  }
}

function parseMrzDate(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = parseInt(yymmdd.slice(0, 2))
  const mm = yymmdd.slice(2, 4)
  const dd = yymmdd.slice(4, 6)
  // Assume 20xx for years 00-40, 19xx for 41-99
  const century = yy <= 40 ? 2000 : 1900
  return `${century + yy}-${mm}-${dd}`
}

function parseVisualText(text: string): PassportData | null {
  const result: PassportData = {
    passportNumber: null,
    expiryDate: null,
    dateOfBirth: null,
    nationality: null,
    fullName: null,
  }

  let found = false

  // Passport number patterns
  const pnMatch = text.match(/(?:passport\s*(?:no|number|#)[.:]*\s*)([A-Z]{1,2}\d{6,8})/i)
    || text.match(/(?:numero\s*passaporto[.:]*\s*)([A-Z]{1,2}\d{6,8})/i)
    || text.match(/\b([A-Z]{2}\d{7})\b/) // Common format: 2 letters + 7 digits
  if (pnMatch) {
    result.passportNumber = pnMatch[1]
    found = true
  }

  // Expiry date patterns
  const expiryMatch = text.match(/(?:date\s*of\s*expiry|expiry\s*date|scadenza)[.:]*\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i)
  if (expiryMatch) {
    result.expiryDate = normalizeDate(expiryMatch[1])
    found = true
  }

  // DOB patterns
  const dobMatch = text.match(/(?:date\s*of\s*birth|data\s*di\s*nascita|born)[.:]*\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i)
  if (dobMatch) {
    result.dateOfBirth = normalizeDate(dobMatch[1])
    found = true
  }

  return found ? result : null
}

function normalizeDate(dateStr: string): string | null {
  const parts = dateStr.split(/[./-]/)
  if (parts.length !== 3) return null

  let day = parseInt(parts[0])
  let month = parseInt(parts[1])
  let year = parseInt(parts[2])

  if (year < 100) year += year <= 40 ? 2000 : 1900
  if (day > 12 && month <= 12) {
    // DD/MM/YYYY format (European)
  } else if (month > 12) {
    // Swap if month > 12 (probably MM/DD)
    ;[day, month] = [month, day]
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
