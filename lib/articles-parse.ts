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
    if (cn.includes("corp") || cn.includes("inc")) result.entity_type = "C-Corp Elected"
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
  const filingPatterns = [
    /(?:filing\s+(?:number|id|no\.?|#))\s*[:;]?\s*([A-Z0-9-]+)/i,
    /(?:file\s+(?:number|no\.?|#))\s*[:;]?\s*([A-Z0-9-]+)/i,
    /(?:nmbr|number)\s*[:;]?\s*(\d{5,})/i,
    /(?:entity\s+(?:number|id))\s*[:;]?\s*([A-Z0-9-]+)/i,
  ]
  for (const pat of filingPatterns) {
    const match = text.match(pat)
    if (match) { result.filing_id = match[1].trim(); break }
  }

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
