/**
 * Reads what is actually PRINTED on an SS-4 PDF (dev job ff2b73d7) — the last line of defence of the IRS fax: the company record can be
 * right while the file about to go out is an older render (a package that failed to rebuild, a page the client signed from a cached
 * copy, a file uploaded by hand). Only the first page is read: the SS-4 is page 1 of both the signed form and the IRS package.
 *
 * It only ever BLOCKS on a positive reading. If the text cannot be read (a scan, an odd PDF) or no Line 6 can be found, the answer is
 * "unknown" and the company-record check alone applies — a file we cannot read is never turned into a dead end.
 */
import { stateCode } from '@/lib/formation/registered-agent-state'

export interface Ss4PdfFacts {
  /** The first page is the IRS Form SS-4 (its title is printed). */
  isSs4: boolean
  /** The two-letter state printed on Line 6 ("Sheridan County, Wyoming" -> "WY"); null when none could be read. */
  line6State: string | null
  /** The Line 6 text as read, for the message to staff. */
  line6Text: string | null
}

const NOT_SS4: Ss4PdfFacts = { isSs4: false, line6State: null, line6Text: null }

/** "Wyoming Name of responsible party" -> "WY": the longest run of leading words that is a state (a state is at most 3 words). */
function leadingState(words: string[]): string | null {
  for (let n = Math.min(words.length, 3); n >= 1; n--) {
    const s = stateCode(words.slice(0, n).join(' '))
    if (s) return s
  }
  return null
}

/** Pure: the facts out of the first page's text. */
export function ss4FactsFromText(text: string): Ss4PdfFacts {
  if (!/Application\s+for\s+Employer\s+Identification\s+Number/i.test(text)) return NOT_SS4
  const m = /([A-Za-z][A-Za-z.'\- ]{0,40}?)\s+County\s*,\s*([A-Za-z][A-Za-z ]{0,40})/.exec(text)
  if (!m) return { isSs4: true, line6State: null, line6Text: null }
  const state = leadingState(m[2].trim().split(/\s+/))
  return { isSs4: true, line6State: state, line6Text: state ? `${m[1].trim()} County, ${m[2].trim()}` : null }
}

export async function readSs4PdfFacts(bytes: Buffer): Promise<Ss4PdfFacts> {
  if (!bytes || bytes.length < 8 || bytes.slice(0, 5).toString('latin1') !== '%PDF-') return NOT_SS4
  try {
    // pdf-parse v1: import the lib file directly (the package index runs a debug test that reads a missing file)
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default as (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>
    const parsed = await pdfParse(bytes, { max: 1 })
    return ss4FactsFromText(parsed.text || '')
  } catch {
    return NOT_SS4
  }
}
