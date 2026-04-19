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

  // MRZ data line first — gives us passport number, nationality, DOB, expiry
  // from a single 44-char line. OCR sometimes splits the name line across
  // breaks (Luca Gallacci 2026-04-18: line 1 came out as two chunks), so we
  // don't require both MRZ lines — just the data line.
  const mrzData = parseMRZDataLine(ocrText)
  if (mrzData) Object.assign(result, mrzData)

  // MRZ name line — optional; gives us full name.
  const mrzName = parseMRZNameLine(ocrText)
  if (mrzName?.fullName) result.fullName = mrzName.fullName

  // Fill anything MRZ didn't give us from visual text patterns.
  const visual = parseVisualText(ocrText)
  if (visual) {
    if (!result.passportNumber && visual.passportNumber) result.passportNumber = visual.passportNumber
    if (!result.expiryDate && visual.expiryDate) result.expiryDate = visual.expiryDate
    if (!result.dateOfBirth && visual.dateOfBirth) result.dateOfBirth = visual.dateOfBirth
    if (!result.nationality && visual.nationality) result.nationality = visual.nationality
    if (!result.fullName && visual.fullName) result.fullName = visual.fullName
  }

  return result
}

/**
 * Find the passport MRZ data line (line 2) anywhere in the text. The data
 * line has a very specific shape:
 *   9 chars [A-Z0-9<]  = passport number + padding
 *   1 char  [0-9]      = passport check digit
 *   3 chars [A-Z<]     = nationality
 *   6 digits           = DOB YYMMDD
 *   1 digit            = DOB check
 *   1 char  [MF<]      = sex
 *   6 digits           = expiry YYMMDD
 *   1 digit            = expiry check
 *   then < padding.
 *
 * We search every normalized line for this shape instead of requiring a
 * separate line 1 match, because OCR sometimes breaks line 1 across
 * multiple shorter chunks that never form a clean 44-char block.
 */
function parseMRZDataLine(text: string): Partial<PassportData> | null {
  const lines = text.split('\n').map(l => l.replace(/\s/g, '')).filter(Boolean)
  const dataLineRe = /^([A-Z0-9<]{9})(\d)([A-Z<]{3})(\d{6})(\d)([MF<])(\d{6})(\d)/
  for (const line of lines) {
    if (!/^[A-Z0-9<]{30,}$/.test(line)) continue
    const m = line.match(dataLineRe)
    if (!m) continue
    const passportNumber = m[1].replace(/</g, '').trim()
    const nationality = m[3].replace(/</g, '').trim()
    return {
      passportNumber: passportNumber || null,
      nationality: nationality || null,
      dateOfBirth: parseMrzDate(m[4]),
      expiryDate: parseMrzDate(m[7]),
    }
  }
  return null
}

/**
 * Find the passport MRZ name line (line 1). Starts with 'P<' + 3-letter
 * country code, then `SURNAME<<GIVENNAMES<...<`. Tolerates split/short
 * lines — we concatenate adjacent MRZ-char-only lines to reconstruct.
 */
function parseMRZNameLine(text: string): Pick<PassportData, "fullName"> | null {
  const rawLines = text.split('\n').map(l => l.replace(/\s/g, '')).filter(Boolean)
  // Start from any line beginning with 'P<' and append following lines that
  // are pure MRZ chars, stopping once we hit a non-MRZ line or hit >= 44 chars.
  for (let i = 0; i < rawLines.length; i++) {
    if (!rawLines[i].startsWith('P<')) continue
    let combined = rawLines[i]
    for (let j = i + 1; j < rawLines.length && combined.length < 44; j++) {
      if (!/^[A-Z0-9<]+$/.test(rawLines[j])) break
      combined += rawLines[j]
    }
    if (combined.length < 10) continue
    const nameSection = combined.slice(5)
    const nameParts = nameSection.split('<<').filter(Boolean)
    if (nameParts.length === 0) continue
    const surname = (nameParts[0] || '').replace(/</g, ' ').trim()
    const givenNames = (nameParts[1] || '').replace(/</g, ' ').trim()
    const fullName = givenNames ? `${givenNames} ${surname}` : surname
    if (fullName) return { fullName }
  }
  return null
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

// Month abbreviations we see on passports — covers English + Italian. Used
// by the visual-text fallback when the OCR output has a date like
// "14 MAR/MAR 2031" (Italian abbrev / English abbrev / year) that the
// numeric-date regex won't match.
const MONTH_ABBREV: Record<string, number> = {
  JAN: 1, GEN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5, MAG: 5,
  JUN: 6, GIU: 6,
  JUL: 7, LUG: 7,
  AUG: 8, AGO: 8,
  SEP: 9, SET: 9,
  OCT: 10, OTT: 10,
  NOV: 11,
  DEC: 12, DIC: 12,
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

  const expiry = findDateNearKeyword(text, /(date\s*of\s*expiry|expiry\s*date|data\s*di\s*scadenza|scadenza)/i)
  if (expiry) {
    result.expiryDate = expiry
    found = true
  }

  const dob = findDateNearKeyword(text, /(date\s*of\s*birth|data\s*di\s*nascita|born)/i)
  if (dob) {
    result.dateOfBirth = dob
    found = true
  }

  return found ? result : null
}

/** Locate a keyword, then scan the next ~200 chars for the first date-shaped
 *  sequence — tries numeric dd/mm/yyyy first, then "DD MMM YYYY" abbrev
 *  (English or Italian, optionally with a localized abbrev pair like
 *  "MAR/MAR"). Handles OCR output that puts a step-index like "(8)" between
 *  the keyword and the value. */
function findDateNearKeyword(text: string, keyword: RegExp): string | null {
  const m = keyword.exec(text)
  if (!m) return null
  const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200)

  const numeric = after.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/)
  if (numeric) {
    const normalized = normalizeDate(numeric[1])
    if (normalized) return normalized
  }

  const abbrev = after.match(/\b(\d{1,2})\s+([A-Z]{3})(?:\s*\/\s*[A-Z]{3})?\s+(\d{4})\b/i)
  if (abbrev) {
    const normalized = parseAbbrevDate(abbrev[1], abbrev[2], abbrev[3])
    if (normalized) return normalized
  }

  return null
}

function parseAbbrevDate(day: string, monthAbbrev: string, year: string): string | null {
  const d = parseInt(day)
  const m = MONTH_ABBREV[monthAbbrev.toUpperCase()]
  const y = parseInt(year)
  if (!m || isNaN(d) || isNaN(y)) return null
  if (d < 1 || d > 31) return null
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
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
