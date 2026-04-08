/**
 * OCR Articles of Organization
 *
 * POST { storage_path, file_name, mime_type }
 *
 * Downloads the file from Supabase Storage (onboarding-uploads bucket),
 * runs Document AI OCR, then parses structured fields:
 *   - company_name (LLC name from the filing)
 *   - entity_type (LLC type — single, multi, etc.)
 *   - state_of_formation (state that issued the filing)
 *   - formation_date (filing/effective date)
 *   - filing_id (state filing number)
 *   - registered_agent (RA name if present)
 *
 * Returns the parsed fields for the chain audit form to auto-fill.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ocrRawContent } from "@/lib/docai"

// ─── Parsing Logic ───

interface ArticlesParsed {
  company_name: string | null
  entity_type: string | null
  state_of_formation: string | null
  formation_date: string | null
  filing_id: string | null
  registered_agent: string | null
  raw_text: string
}

function parseArticlesText(text: string): ArticlesParsed {
  const result: ArticlesParsed = {
    company_name: null,
    entity_type: null,
    state_of_formation: null,
    formation_date: null,
    filing_id: null,
    registered_agent: null,
    raw_text: text,
  }

  // ── Company Name ──
  // Pattern 1: "Name of Limited Liability Company: XYZ LLC"
  // Pattern 2: "The name of the limited liability company is: XYZ LLC"
  // Pattern 3: "Entity Name: XYZ LLC"
  // Pattern 4: "1. Name: XYZ LLC" or "1. The name ... is XYZ LLC"
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
      let name = match[1].trim()
      // Clean up trailing punctuation, periods, etc.
      name = name.replace(/[.;,]+$/, "").trim()
      // Remove quotes if present
      name = name.replace(/^["']|["']$/g, "").trim()
      if (name.length > 2 && name.length < 200) {
        result.company_name = name
        break
      }
    }
  }

  // ── Entity Type ──
  // Look for LLC type indicators
  if (/multi[- ]?member/i.test(text) || /more\s+than\s+one\s+member/i.test(text)) {
    result.entity_type = "Multi Member LLC"
  } else if (/single[- ]?member/i.test(text) || /one\s+member/i.test(text) || /sole\s+member/i.test(text)) {
    result.entity_type = "Single Member LLC"
  } else if (/limited\s+liability\s+company/i.test(text) || /\.?\s*LLC\b/.test(text)) {
    // Default to Single Member if just "LLC" without specifying members
    result.entity_type = "Single Member LLC"
  }

  // If company name contains clues
  if (result.company_name) {
    const cn = result.company_name.toLowerCase()
    if (cn.includes("corp") || cn.includes("inc")) {
      result.entity_type = "C-Corp Elected"
    }
  }

  // ── State of Formation ──
  const statePatterns = [
    /state\s+of\s+new\s+mexico/i,
    /new\s+mexico\s+secretary\s+of\s+state/i,
    /filed\s+(?:in|with)\s+(?:the\s+)?(?:state\s+of\s+)?new\s+mexico/i,
    /(?:state|commonwealth)\s+of\s+new\s+mexico/i,
  ]
  if (statePatterns.some(p => p.test(text))) {
    result.state_of_formation = "New Mexico"
  }

  // Check for other states
  const stateMap: Record<string, RegExp> = {
    Wyoming: /(?:state\s+of\s+)?wyoming|wyoming\s+secretary/i,
    Delaware: /(?:state\s+of\s+)?delaware|delaware\s+secretary|division\s+of\s+corporations/i,
    Florida: /(?:state\s+of\s+)?florida|florida\s+department\s+of\s+state/i,
    Texas: /(?:state\s+of\s+)?texas|texas\s+secretary/i,
    Nevada: /(?:state\s+of\s+)?nevada|nevada\s+secretary/i,
  }
  if (!result.state_of_formation) {
    for (const [state, regex] of Object.entries(stateMap)) {
      if (regex.test(text)) {
        result.state_of_formation = state
        break
      }
    }
  }

  // ── Formation Date ──
  // Pattern 1: "Filed Date: MM/DD/YYYY" or "Filing Date: ..."
  // Pattern 2: "Effective Date: ..."
  // Pattern 3: "Date: March 15, 2026"
  // Pattern 4: "FILED MM-DD-YYYY"
  const datePatterns = [
    /(?:file[d]?\s+date|filing\s+date|effective\s+date|date\s+(?:of\s+)?(?:filing|formation|organization))\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:file[d]?\s+date|filing\s+date|effective\s+date)\s*[:;]?\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
    /(?:filed|effective)\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:date\s+filed|date\s+of\s+filing)\s*[:;]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    /(?:date\s+filed|date\s+of\s+filing)\s*[:;]?\s*(\w+\s+\d{1,2},?\s+\d{4})/i,
  ]

  for (const pat of datePatterns) {
    const match = text.match(pat)
    if (match) {
      const rawDate = match[1].trim()
      const parsed = tryParseDate(rawDate)
      if (parsed) {
        result.formation_date = parsed
        break
      }
    }
  }

  // ── Filing ID ──
  const filingPatterns = [
    /(?:filing\s+(?:number|id|no\.?|#))\s*[:;]?\s*([A-Z0-9-]+)/i,
    /(?:file\s+(?:number|no\.?|#))\s*[:;]?\s*([A-Z0-9-]+)/i,
    /(?:nmbr|number)\s*[:;]?\s*(\d{5,})/i,
    /(?:entity\s+(?:number|id))\s*[:;]?\s*([A-Z0-9-]+)/i,
  ]

  for (const pat of filingPatterns) {
    const match = text.match(pat)
    if (match) {
      result.filing_id = match[1].trim()
      break
    }
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
      if (ra.length > 2 && ra.length < 200) {
        result.registered_agent = ra
        break
      }
    }
  }

  return result
}

function tryParseDate(raw: string): string | null {
  // Try MM/DD/YYYY or MM-DD-YYYY
  const slashMatch = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (slashMatch) {
    const [, m, d, y_raw] = slashMatch
    let y = y_raw
    if (y.length === 2) y = "20" + y
    const month = m.padStart(2, "0")
    const day = d.padStart(2, "0")
    return `${y}-${month}-${day}`
  }

  // Try "Month DD, YYYY" or "Month DD YYYY"
  const monthNames: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
    jan: "01", feb: "02", mar: "03", apr: "04",
    jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  }

  const namedMatch = raw.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (namedMatch) {
    const monthKey = namedMatch[1].toLowerCase()
    const month = monthNames[monthKey]
    if (month) {
      const day = namedMatch[2].padStart(2, "0")
      return `${namedMatch[3]}-${month}-${day}`
    }
  }

  return null
}

// ─── POST Handler ───

export async function POST(req: NextRequest) {
  try {
    const { storage_path, file_name, mime_type } = await req.json()

    if (!storage_path || !file_name) {
      return NextResponse.json({ error: "storage_path and file_name required" }, { status: 400 })
    }

    // Download from Supabase Storage
    const { data: fileData, error: dlError } = await supabaseAdmin
      .storage
      .from("onboarding-uploads")
      .download(storage_path)

    if (dlError || !fileData) {
      return NextResponse.json({ error: `Failed to download: ${dlError?.message ?? "no data"}` }, { status: 500 })
    }

    const buffer = await fileData.arrayBuffer()
    const resolvedMime = mime_type || "application/pdf"

    // Run OCR
    const ocrResult = await ocrRawContent(buffer, resolvedMime, file_name)

    if (!ocrResult.fullText || ocrResult.fullText.length < 20) {
      return NextResponse.json({
        error: "OCR returned insufficient text. The file may be an image that couldn't be read, or it may be empty.",
        raw_text: ocrResult.fullText ?? "",
      }, { status: 422 })
    }

    // Parse structured fields
    const parsed = parseArticlesText(ocrResult.fullText)

    return NextResponse.json({
      success: true,
      ...parsed,
      page_count: ocrResult.pageCount,
      ocr_confidence: ocrResult.confidence,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
