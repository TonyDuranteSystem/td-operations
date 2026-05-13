/**
 * Conservative DBA-document OCR extraction.
 *
 * DBA / trade-name certificates vary widely by state — we cannot reliably
 * parse arbitrary documents. This helper looks for a small set of labeled
 * patterns that are common across jurisdictions ("Filed:", "Date Filed:",
 * "Filing Date:", "Registration No:", "Certificate No:", "DBA Number:").
 * The caller only writes the result when the destination field is empty,
 * so a false positive does not overwrite operator-entered data.
 *
 * Returned fields are strict ISO/text:
 *   - filed_date: YYYY-MM-DD, or null
 *   - registration_number: trimmed string up to 32 chars, or null
 */

const MONTH_NAMES: Record<string, string> = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sept: '09', sep: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12',
}

const FILED_DATE_LABELS = [
  'date\\s*filed',
  'filed\\s*on',
  'filing\\s*date',
  'date\\s*of\\s*filing',
  'filed',
]

const REG_NUMBER_LABELS = [
  'registration\\s*(?:no\\.?|number|#)',
  'certificate\\s*(?:no\\.?|number|#)',
  'dba\\s*(?:no\\.?|number|#)',
  'document\\s*(?:no\\.?|number|#)',
  'file\\s*(?:no\\.?|number|#)',
]

function normalizeDate(month: string, day: string, year: string): string | null {
  let mm = month
  if (!/^\d+$/.test(month)) {
    const lookup = MONTH_NAMES[month.toLowerCase()]
    if (!lookup) return null
    mm = lookup
  }
  const mNum = Number(mm)
  const dNum = Number(day)
  const yNum = Number(year.length === 2 ? `20${year}` : year)
  if (!Number.isFinite(mNum) || !Number.isFinite(dNum) || !Number.isFinite(yNum)) return null
  if (mNum < 1 || mNum > 12) return null
  if (dNum < 1 || dNum > 31) return null
  if (yNum < 1900 || yNum > 2100) return null
  const mmStr = String(mNum).padStart(2, '0')
  const ddStr = String(dNum).padStart(2, '0')
  return `${yNum}-${mmStr}-${ddStr}`
}

function findLabeledDate(text: string): string | null {
  const monthAlts = Object.keys(MONTH_NAMES).join('|')
  // "Filed: January 5, 2024" / "Date Filed 1/5/2024" / "Filing Date: 2024-01-05"
  for (const label of FILED_DATE_LABELS) {
    const named = new RegExp(
      `${label}\\s*[:\\-]?\\s*(${monthAlts})\\s+(\\d{1,2}),?\\s+(\\d{2,4})`,
      'i',
    )
    const slash = new RegExp(
      `${label}\\s*[:\\-]?\\s*(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})`,
      'i',
    )
    const iso = new RegExp(
      `${label}\\s*[:\\-]?\\s*(\\d{4})-(\\d{1,2})-(\\d{1,2})`,
      'i',
    )

    const isoMatch = iso.exec(text)
    if (isoMatch) {
      const d = normalizeDate(isoMatch[2], isoMatch[3], isoMatch[1])
      if (d) return d
    }
    const namedMatch = named.exec(text)
    if (namedMatch) {
      const d = normalizeDate(namedMatch[1], namedMatch[2], namedMatch[3])
      if (d) return d
    }
    const slashMatch = slash.exec(text)
    if (slashMatch) {
      const d = normalizeDate(slashMatch[1], slashMatch[2], slashMatch[3])
      if (d) return d
    }
  }
  return null
}

function findLabeledRegistrationNumber(text: string): string | null {
  for (const label of REG_NUMBER_LABELS) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*([A-Za-z0-9][A-Za-z0-9\\-]{2,30})`, 'i')
    const m = re.exec(text)
    if (m) {
      const raw = m[1].trim()
      // Strip trailing punctuation operators might leak in.
      const cleaned = raw.replace(/[.,;]+$/, '')
      if (cleaned.length >= 3 && cleaned.length <= 32) return cleaned
    }
  }
  return null
}

export interface DbaExtractionResult {
  filed_date: string | null
  registration_number: string | null
}

export function extractDbaFieldsFromOcr(text: string): DbaExtractionResult {
  if (!text || typeof text !== 'string') {
    return { filed_date: null, registration_number: null }
  }
  return {
    filed_date: findLabeledDate(text),
    registration_number: findLabeledRegistrationNumber(text),
  }
}
