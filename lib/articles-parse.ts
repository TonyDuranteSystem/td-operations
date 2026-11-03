/**
 * Articles of Organization text parser — shared, pure, unit-tested.
 *
 * Extracted from app/api/crm/admin-actions/ocr-articles/route.ts so BOTH the
 * legacy chain-audit OCR path AND the formation workspace ("Articles Received"
 * date confirmation) use the SAME parsing rules. Pure (string in, fields out) so
 * it is fully unit-testable with real state-filing text.
 *
 * The formation date is the single most important field for the SS-4 (Line 11,
 * "date business started"). The NM Secretary of State stamps the document
 * "Date Filed: M/D/YYYY"; that header form was NOT matched by the original
 * patterns (they only handled "Filed Date" / "Filing Date" / "Effective Date"),
 * which is why the workspace path fell back to today() and produced wrong dates.
 */

import { cleanNameText, hasValidLlcEnding, MAX_LEGAL_NAME_LENGTH } from "@/lib/flows/legal-name"

export interface ArticlesParsed {
  company_name: string | null
  entity_type: string | null
  state_of_formation: string | null
  formation_date: string | null // ISO YYYY-MM-DD
  filing_id: string | null
  registered_agent: string | null
}

/** Parse a date string ("6/16/2026", "June 16, 2026", "06-16-26") → ISO YYYY-MM-DD, or null. */
export function tryParseDate(raw: string): string | null {
  // MM/DD/YYYY or MM-DD-YYYY (also 2-digit year)
  const slashMatch = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (slashMatch) {
    const [, m, d, y_raw] = slashMatch
    let y = y_raw
    if (y.length === 2) y = "20" + y
    const month = m.padStart(2, "0")
    const day = d.padStart(2, "0")
    return `${y}-${month}-${day}`
  }

  const monthNames: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  }

  // "Month DD, YYYY" / "Month DD YYYY"
  const namedMatch = raw.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (namedMatch) {
    const month = monthNames[namedMatch[1].toLowerCase()]
    if (month) {
      const day = namedMatch[2].padStart(2, "0")
      return `${namedMatch[3]}-${month}-${day}`
    }
  }

  // "this 18 day of June 2026" (registered-agent acceptance / signature blocks)
  const dayOfMonth = raw.match(/(\d{1,2})\s+day\s+of\s+(\w+),?\s+(\d{4})/i)
  if (dayOfMonth) {
    const month = monthNames[dayOfMonth[2].toLowerCase()]
    if (month) {
      const day = dayOfMonth[1].padStart(2, "0")
      return `${dayOfMonth[3]}-${month}-${day}`
    }
  }

  return null
}

/** Extract the formation (filing) date from Articles OCR text → ISO, or null. */
export function parseFormationDate(text: string): string | null {
  const datePatterns = [
    // NM SoS header: "Date Filed: 6/16/2026" (the previously-missed format)
    /date\s+filed\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /date\s+filed\s*[:;]?\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
    // "Filed Date / Filing Date / Effective Date / Date of filing/formation/organization"
    /(?:file[d]?\s+date|filing\s+date|effective\s+date|date\s+(?:of\s+)?(?:filing|formation|organization))\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:file[d]?\s+date|filing\s+date|effective\s+date)\s*[:;]?\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
    /(?:filed|effective)\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    // RA acceptance / signature: "this 16 day of June 2026"
    /(\d{1,2}\s+day\s+of\s+\w+,?\s+\d{4})/i,
  ]
  for (const pat of datePatterns) {
    const match = text.match(pat)
    if (match) {
      const parsed = tryParseDate(match[1].trim())
      if (parsed) return parsed
    }
  }
  return null
}

// ─── The state's Filing ID printed on the Articles (prefill for the upload window's "State Filing ID" field) ──────────────────────

/**
 * The state Filing ID as printed on the Articles, or null when the text does not carry one with confidence. PREFILL ONLY — staff
 * confirm it in the upload window — so this favours PRECISION over recall: every pattern is anchored on a label or on a shape that
 * only a Filing ID has, and there is deliberately NO "any long number" fallback (a New Mexico Articles also prints the registered
 * agent's own 7-digit id, which such a fallback would pick). Checked against 100 real stored Articles (job 64d2be64): every ID the
 * Articles print is read right; the ones it misses are Articles whose OCR text carries no readable ID (the field is then left empty
 * for staff to type).
 *   Wyoming   "Original ID: 2025-001586941"            Florida  "L26000009149" (the document-number stamp)
 *   New Mexico "File #: 3190157" / "Filing Number: 0002313166", or the stamp number when OCR drops its label
 *   Delaware  "File Number 6462038"
 */
export function parseFilingId(text: string): string | null {
  if (typeof text !== "string" || !text) return null
  const t = text.replace(/ /g, " ")
  const tries: Array<() => string | null> = [
    // 1. A labelled ID, in each state's wording.
    () => { const m = t.match(/(?:original|filing)\s+id\s*[:;]?\s*(\d{4})\s*-\s*(\d{9})\b/i); return m ? `${m[1]}-${m[2]}` : null },
    () => { const m = t.match(/\bfil(?:e|ing)\s*(?:number|no\.?|num\.?|#)\s*[:;]?\s*(\d{6,10})\b/i); return m ? m[1] : null },
    () => { const m = t.match(/\bdocument\s+(?:number|no\.?|#)\s*[:;]?\s*(L\d{11})\b/i); return m ? m[1] : null },
    // 2. A shape only a Filing ID has: Florida "L" + 11 digits; Wyoming year + "-" + 9 digits.
    () => { const m = t.match(/\b(L\d{11})\b/); return m ? m[1] : null },
    () => { const m = t.match(/(?<![\d-])(20\d{2})\s*-\s*(\d{9})(?!\d)/); return m ? `${m[1]}-${m[2]}` : null },
    // 3. The New Mexico stamp number when the OCR printed it without its "File #" label (two real layouts).
    () => { const m = t.match(/filed\s+by\s+the\s+secretary\s+of\s+state\.\s+(\d{7})\s+-{3}\s*page\s+break/i); return m ? m[1] : null },
    () => { const m = t.match(/certificate\s+of\s+organization\s+of\s+[^\n]{2,80}?\b(?:llc|l\.l\.c\.)\s+(\d{7})\s+new\s+mexico/i); return m ? m[1] : null },
  ]
  for (const attempt of tries) {
    const found = attempt()
    if (found) return found
  }
  return null
}

/**
 * A Filing ID as staff typed or confirmed it, tidied for saving: trimmed, upper-cased, and the spaces OCR / typing leaves around
 * the dash removed ("2025 - 001586941" → "2025-001586941"). Letters, digits and dashes only, 4–30 characters, at least one digit.
 * Anything else → null (the caller refuses it with a plain message instead of saving a half-typed value).
 */
export function normalizeFilingId(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const cleaned = raw.trim().toUpperCase().replace(/\s*-\s*/g, "-")
  if (!/^[A-Z0-9-]{4,30}$/.test(cleaned)) return null
  if (!/\d/.test(cleaned)) return null
  return cleaned
}

export function parseArticlesText(text: string): ArticlesParsed {
  const result: ArticlesParsed = {
    company_name: null,
    entity_type: null,
    state_of_formation: null,
    formation_date: null,
    filing_id: null,
    registered_agent: null,
  }

  // ── Company Name ──
  const namePatterns = [
    /(?:name\s+of\s+(?:the\s+)?(?:limited\s+liability\s+company|LLC|entity|domestic\s+LLC))\s*[:;]?\s*([^\n]+)/i,
    /(?:entity\s+name)\s*[:;]?\s*([^\n]+)/i,
    /(?:1\.\s*(?:the\s+)?name\s*(?:of\s+the\s+(?:limited\s+liability\s+company|LLC))?\s*(?:is|shall\s+be)?\s*[:;]?\s*)([^\n]+)/i,
    /(?:company\s+name)\s*[:;]?\s*([^\n]+)/i,
    /(?:the\s+name\s+(?:of\s+this|of\s+the)\s+(?:limited\s+liability\s+)?company\s+(?:is|shall\s+be))\s*[:;]?\s*([^\n]+)/i,
  ]
  for (const pat of namePatterns) {
    const match = text.match(pat)
    if (match) {
      const name = match[1].trim().replace(/[.;,]+$/, "").trim().replace(/^["']|["']$/g, "").trim()
      if (name.length > 2 && name.length < 200) {
        result.company_name = name
        break
      }
    }
  }

  // ── Entity Type ──
  if (/multi[- ]?member/i.test(text) || /more\s+than\s+one\s+member/i.test(text)) {
    result.entity_type = "Multi Member LLC"
  } else if (/single[- ]?member/i.test(text) || /one\s+member/i.test(text) || /sole\s+member/i.test(text)) {
    result.entity_type = "Single Member LLC"
  } else if (/limited\s+liability\s+company/i.test(text) || /\.?\s*LLC\b/.test(text)) {
    result.entity_type = "Single Member LLC"
  }
  if (result.company_name) {
    const cn = result.company_name.toLowerCase()
    // Whole words only: "Lincoln Partners LLC" / "Zinc LLC" are not corporations (a substring test flagged them).
    if (/\b(corp|corporation|inc|incorporated)\b/.test(cn)) result.entity_type = "C-Corp Elected"
  }

  // ── State of Formation ──
  const nmPatterns = [
    /state\s+of\s+new\s+mexico/i,
    /new\s+mexico\s+secretary\s+of\s+state/i,
    /filed\s+(?:in|with)\s+(?:the\s+)?(?:state\s+of\s+)?new\s+mexico/i,
    /(?:state|commonwealth)\s+of\s+new\s+mexico/i,
  ]
  if (nmPatterns.some(p => p.test(text))) {
    result.state_of_formation = "New Mexico"
  } else {
    const stateMap: Record<string, RegExp> = {
      Wyoming: /(?:state\s+of\s+)?wyoming|wyoming\s+secretary/i,
      Delaware: /(?:state\s+of\s+)?delaware|delaware\s+secretary|division\s+of\s+corporations/i,
      Florida: /(?:state\s+of\s+)?florida|florida\s+department\s+of\s+state/i,
      Texas: /(?:state\s+of\s+)?texas|texas\s+secretary/i,
      Nevada: /(?:state\s+of\s+)?nevada|nevada\s+secretary/i,
    }
    for (const [state, regex] of Object.entries(stateMap)) {
      if (regex.test(text)) { result.state_of_formation = state; break }
    }
  }

  // ── Formation Date ──
  result.formation_date = parseFormationDate(text)

  // ── Filing ID ──
  result.filing_id = parseFilingId(text)

  // ── Registered Agent ──
  const raPatterns = [
    /(?:registered\s+agent)\s*[:;]?\s*([^\n]+)/i,
    /(?:agent\s+(?:for\s+)?service\s+of\s+process)\s*[:;]?\s*([^\n]+)/i,
  ]
  for (const pat of raPatterns) {
    const match = text.match(pat)
    if (match) {
      const ra = match[1].trim().replace(/[.;,]+$/, "").trim()
      if (ra.length > 2 && ra.length < 200) { result.registered_agent = ra; break }
    }
  }

  return result
}

// ─── The company name printed on the Articles (prefill for the upload window's "Company legal name" field) ────────────────────────

const NAME_LABELS: RegExp[] = [
  /limited\s+liability\s+company\s+name\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
  /name\s+of\s+(?:the\s+)?(?:limited\s+liability\s+company|LLC|entity|domestic\s+LLC)\s*(?:is|shall\s+be)?\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
  /entity\s+name\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
  /company\s+name\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
  /the\s+name\s+of\s+(?:this|the)\s+(?:limited\s+liability\s+)?company\s+(?:is|shall\s+be)\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
  /(?:first|1\.|article\s+(?:i|1)\b)[^\n]{0,40}?name[^\n]{0,60}?(?:is|shall\s+be)\s*[:;]?\s*([^\n]+)((?:\n[^\n]*)?)/i,
]
// A second line that is only the ending ("Tanto Per" / "LLC") — the name wrapped.
const LONE_ENDING = /^\s*(llc|l\.\s?l\.\s?c\.?|pllc|limited liability company)\s*[.,;]?\s*$/i
// Instruction / label text that is NOT a company name.
const NOT_A_NAME = /(must\s+(include|contain|end)|designator|required|shall\s+include|should|please|example|e\.g\.|\(|:|\bname\s+of\b|secretary\s+of\s+state|effective\s+date)/i

/**
 * The company name as printed on the Articles, or null when it cannot be read with confidence. PREFILL ONLY (staff confirm it in the
 * upload window): it never decorates a name — a candidate without a valid LLC ending is rejected, never completed — and it keeps the
 * Articles' own capitals and a dotted ending's final period ("Acme L.L.C."). A name wrapped onto a second line ("Tanto Per" / "LLC")
 * is joined. Synthetic WY / FL / DE layouts are tested; only the NM layout is a real sample.
 */
export function parseArticlesCompanyName(text: string): string | null {
  if (typeof text !== "string" || !text) return null
  for (const pat of NAME_LABELS) {
    const m = text.match(pat)
    if (!m) continue
    let candidate = cleanNameText(m[1])
    const nextLine = cleanNameText(m[2])
    // The captured line is just the label's tail or empty → the name is on the next line.
    if (!candidate) continue
    if (nextLine && LONE_ENDING.test(nextLine) && !hasValidLlcEnding(candidate)) candidate = `${candidate} ${nextLine}`
    candidate = candidate.replace(/^["'\u2018\u201C]+|["'\u2019\u201D]+$/g, "").replace(/[;,\s]+$/, "").trim()
    // A sentence full stop is not part of the name — but "L.L.C." keeps its dot.
    if (candidate.endsWith(".") && !/\b(l\.\s?l\.\s?c|l\.\s?c|p\.\s?l\.\s?l\.\s?c)\.$/i.test(candidate)) candidate = candidate.slice(0, -1).trim()
    if (candidate.length < 3 || candidate.length > MAX_LEGAL_NAME_LENGTH) continue
    if (NOT_A_NAME.test(candidate)) continue
    if (!hasValidLlcEnding(candidate)) continue
    return candidate
  }
  return null
}
