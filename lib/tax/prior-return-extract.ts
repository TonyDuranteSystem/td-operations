/**
 * Prior-year tax return ingestion (Slice 6, master plan §5).
 *
 * Reads a filed return PDF (1065 / 1120) and extracts the numbers the current
 * year's financials depend on: Schedule L beginning/ending balances, M-2,
 * and each partner's K-1 (name, ownership %, item L ending capital).
 *
 * Pipeline: pdf-parse text → Claude forced-schema extraction → INTERNAL
 * VALIDATION before anything is used (columns must balance, M-2 must tie to
 * Schedule L capital, K-1s must sum to the total). A return that fails
 * validation is QUARANTINED — stored with its issues for staff review, never
 * silently fed into the current year's beginning balances.
 *
 * Gate 2 of the six verification gates reads validated.schedule_l.ending.cash
 * as the current year's beginning cash.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

const MODEL = "claude-sonnet-4-6"
const MAX_TOKENS = 4096
const TIMEOUT_MS = 120_000
/** Identity checks tolerate rounding to the dollar on both sides. */
const TOLERANCE = 2.0

export interface ScheduleLColumn {
  cash: number | null
  total_assets: number | null
  total_liabilities: number | null
  /** Partners' capital (1065 L21) or retained earnings (1120 L25). */
  capital: number | null
}

export interface PriorReturnK1 {
  partner_name: string
  ownership_pct: number | null
  ending_capital: number | null
}

export interface PriorReturnExtraction {
  form_type: "1065" | "1120" | "1120-F" | "other"
  tax_year: number | null
  ein: string | null
  schedule_l: { beginning: ScheduleLColumn; ending: ScheduleLColumn } | null
  /** 1065 Schedule M-2: line 1 beginning capital … line 9 ending capital. */
  m2: { beginning_capital: number | null; ending_capital: number | null } | null
  k1s: PriorReturnK1[]
}

export interface PriorReturnValidationIssue {
  code:
    | "WRONG_YEAR"
    | "UNSUPPORTED_FORM"
    | "NO_SCHEDULE_L"
    | "SCHEDULE_L_UNBALANCED"
    | "M2_MISMATCH"
    | "K1_SUM_MISMATCH"
    | "K1_PCT_SUM"
    | "EIN_MISMATCH"
  message: string
}

export interface PriorReturnRecord {
  status: "validated" | "quarantined"
  extracted: PriorReturnExtraction
  issues: PriorReturnValidationIssue[]
  source: string
  extracted_at: string
}

const EXTRACT_TOOL = {
  name: "extract_prior_return",
  description: "Extract the structured numbers from a filed US tax return.",
  input_schema: {
    type: "object",
    properties: {
      form_type: { type: "string", enum: ["1065", "1120", "1120-F", "other"], description: "The main form type from page 1." },
      tax_year: { type: "integer", description: "The tax year this return covers (from page 1, e.g. 2024). Null if unreadable." },
      ein: { type: "string", description: "Employer Identification Number from page 1, digits and dash only (e.g. 12-3456789). Empty string if unreadable." },
      schedule_l: {
        type: "object",
        description: "Schedule L 'Balance Sheets per Books'. Columns (a)/(b) are beginning of year, (c)/(d) end of year. Use the END-of-column totals. Null fields when the line is blank.",
        properties: {
          beginning: {
            type: "object",
            properties: {
              cash: { type: "number", description: "Line 1 Cash, beginning of year" },
              total_assets: { type: "number", description: "Total assets line, beginning" },
              total_liabilities: { type: "number", description: "Total liabilities (NOT including capital/equity), beginning" },
              capital: { type: "number", description: "1065: line 21 Partners' capital accounts, beginning. 1120: line 25 Retained earnings (+ capital stock line 22 + paid-in line 23 if present, summed)." },
            },
          },
          ending: {
            type: "object",
            properties: {
              cash: { type: "number" },
              total_assets: { type: "number" },
              total_liabilities: { type: "number" },
              capital: { type: "number" },
            },
          },
        },
      },
      m2: {
        type: "object",
        description: "1065 Schedule M-2 (Analysis of Partners' Capital Accounts). Omit entirely for 1120.",
        properties: {
          beginning_capital: { type: "number", description: "M-2 line 1" },
          ending_capital: { type: "number", description: "M-2 line 9" },
        },
      },
      k1s: {
        type: "array",
        description: "One entry per Schedule K-1 found in the document (1065 only; empty array for 1120).",
        items: {
          type: "object",
          properties: {
            partner_name: { type: "string", description: "Part II item F, the partner's name" },
            ownership_pct: { type: "number", description: "Part II item J 'Profit' ENDING percentage, as a number 0-100. Null if unreadable." },
            ending_capital: { type: "number", description: "Part II item L 'Ending capital account'. Null if unreadable." },
          },
          required: ["partner_name"],
        },
      },
    },
    required: ["form_type", "k1s"],
  },
} as const

const SYSTEM_PROMPT = [
  "You extract structured data from filed US business tax returns (Form 1065 partnership returns and Form 1120 corporate returns).",
  "The text comes from a PDF text layer — columns may be jumbled. Locate Schedule L by the heading 'Balance Sheets per Books', Schedule M-2 by 'Analysis of Partners' Capital Accounts', and K-1s by 'Schedule K-1'.",
  "Schedule L columns: (a)+(b) = beginning of tax year, (c)+(d) = end of tax year. Line 1 is Cash.",
  "Extract numbers EXACTLY as printed (no sign flips, no rounding). Use null for anything you cannot read confidently — null is safe, a guessed number corrupts a tax return.",
  "Always respond by calling the extract_prior_return tool.",
].join(" ")

/** Parse + sanity-coerce the raw tool output. Exported for tests. */
export function parseExtraction(raw: unknown): PriorReturnExtraction | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const formType = ["1065", "1120", "1120-F", "other"].includes(r.form_type as string)
    ? (r.form_type as PriorReturnExtraction["form_type"]) : "other"
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const col = (v: unknown): ScheduleLColumn => {
    const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>
    return { cash: num(c.cash), total_assets: num(c.total_assets), total_liabilities: num(c.total_liabilities), capital: num(c.capital) }
  }
  const sl = r.schedule_l && typeof r.schedule_l === "object"
    ? { beginning: col((r.schedule_l as Record<string, unknown>).beginning), ending: col((r.schedule_l as Record<string, unknown>).ending) }
    : null
  const m2raw = r.m2 && typeof r.m2 === "object" ? (r.m2 as Record<string, unknown>) : null
  const k1s: PriorReturnK1[] = Array.isArray(r.k1s)
    ? (r.k1s as unknown[]).flatMap(k => {
        if (!k || typeof k !== "object") return []
        const kk = k as Record<string, unknown>
        if (typeof kk.partner_name !== "string" || !kk.partner_name.trim()) return []
        return [{ partner_name: kk.partner_name.trim(), ownership_pct: num(kk.ownership_pct), ending_capital: num(kk.ending_capital) }]
      })
    : []
  return {
    form_type: formType,
    tax_year: typeof r.tax_year === "number" && Number.isInteger(r.tax_year) ? r.tax_year : null,
    ein: typeof r.ein === "string" && r.ein.trim() ? r.ein.trim() : null,
    schedule_l: sl,
    m2: m2raw ? { beginning_capital: num(m2raw.beginning_capital), ending_capital: num(m2raw.ending_capital) } : null,
    k1s,
  }
}

export interface PriorReturnExpectations {
  /** The CURRENT filing year — the prior return must cover expectedYear (i.e. current − 1). */
  priorYear: number
  /** Account EIN if we have it — mismatch quarantines (wrong company's return). */
  ein?: string | null
}

/**
 * Internal validation (master plan §5) — every identity that must hold inside
 * a coherent return. ANY issue → quarantine; staff resolves. Pure, DI-free.
 */
export function validatePriorReturn(x: PriorReturnExtraction, expect: PriorReturnExpectations): PriorReturnValidationIssue[] {
  const issues: PriorReturnValidationIssue[] = []
  const close = (a: number | null, b: number | null) =>
    a !== null && b !== null && Math.abs(a - b) <= TOLERANCE

  if (x.form_type === "other") {
    issues.push({ code: "UNSUPPORTED_FORM", message: "Could not identify the form as 1065/1120 — staff must review this document." })
  }
  if (x.tax_year !== null && x.tax_year !== expect.priorYear) {
    issues.push({ code: "WRONG_YEAR", message: `This return covers ${x.tax_year}, but the prior year for this filing is ${expect.priorYear}.` })
  }
  const normEin = (e: string) => e.replace(/\D/g, "")
  if (expect.ein && x.ein && normEin(expect.ein) !== normEin(x.ein)) {
    issues.push({ code: "EIN_MISMATCH", message: `The EIN on the return (${x.ein}) does not match the company's EIN on file.` })
  }
  if (!x.schedule_l || (x.schedule_l.ending.cash === null && x.schedule_l.ending.total_assets === null)) {
    issues.push({ code: "NO_SCHEDULE_L", message: "Schedule L (Balance Sheets per Books) was not found or is blank — beginning balances cannot be established from this document." })
    return issues // the remaining identities all need Schedule L
  }
  for (const side of ["beginning", "ending"] as const) {
    const c = x.schedule_l[side]
    if (c.total_assets !== null && c.total_liabilities !== null && c.capital !== null) {
      if (!close(c.total_assets, c.total_liabilities + c.capital)) {
        issues.push({ code: "SCHEDULE_L_UNBALANCED", message: `Schedule L ${side} column does not balance: assets ${c.total_assets} ≠ liabilities ${c.total_liabilities} + capital ${c.capital}.` })
      }
    }
  }
  if (x.form_type === "1065" && x.m2?.ending_capital !== null && x.m2?.ending_capital !== undefined && x.schedule_l.ending.capital !== null) {
    if (!close(x.m2.ending_capital, x.schedule_l.ending.capital)) {
      issues.push({ code: "M2_MISMATCH", message: `M-2 ending capital ${x.m2.ending_capital} does not tie to Schedule L ending capital ${x.schedule_l.ending.capital}.` })
    }
  }
  if (x.form_type === "1065" && x.k1s.length > 0) {
    const caps = x.k1s.map(k => k.ending_capital)
    if (caps.every(c => c !== null) && x.schedule_l.ending.capital !== null) {
      const sum = caps.reduce((s: number, c) => s + (c as number), 0)
      if (!close(sum, x.schedule_l.ending.capital)) {
        issues.push({ code: "K1_SUM_MISMATCH", message: `K-1 ending capital accounts sum to ${sum}, but Schedule L ending capital is ${x.schedule_l.ending.capital}.` })
      }
    }
    const pcts = x.k1s.map(k => k.ownership_pct)
    if (pcts.every(p => p !== null)) {
      const sum = pcts.reduce((s: number, p) => s + (p as number), 0)
      if (Math.abs(sum - 100) > 0.5) {
        issues.push({ code: "K1_PCT_SUM", message: `K-1 ownership percentages sum to ${sum}%, expected 100%.` })
      }
    }
  }
  return issues
}

export interface ExtractPriorReturnOptions {
  fetchImpl?: typeof fetch
  model?: string
}

/**
 * Full pipeline: PDF buffer → text → AI extraction → validation → record.
 * Never throws on bad documents — failures come back as a quarantined record
 * (or null when the document is unreadable as a PDF at all).
 */
export async function extractPriorReturn(
  pdfBuffer: Buffer,
  source: string,
  expect: PriorReturnExpectations,
  opts?: ExtractPriorReturnOptions,
): Promise<PriorReturnRecord | { status: "failed"; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { status: "failed", error: "ANTHROPIC_API_KEY not set" }

  let text: string
  try {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (buf: Buffer) => Promise<{ text: string }>
    text = (await pdfParse(pdfBuffer)).text
  } catch (e) {
    return { status: "failed", error: `Not a readable PDF: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!text || text.trim().length < 200) {
    return { status: "failed", error: "The PDF has no extractable text (likely a scan) — staff must process it manually." }
  }

  // Returns can be hundreds of pages (attachments, statements). Keep page 1
  // plus the sections we need, located by heading text — not page numbers.
  const trimmed = relevantSections(text)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const doFetch = opts?.fetchImpl ?? fetch
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: opts?.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "extract_prior_return" },
        messages: [{ role: "user", content: `Extract the data from this filed tax return:\n\n${trimmed}` }],
      }),
    })
    clearTimeout(timer)
    if (!res.ok) return { status: "failed", error: `Claude API ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = await res.json() as { content?: Array<{ type: string; name?: string; input?: unknown }> }
    const toolBlock = data.content?.find(b => b.type === "tool_use" && b.name === "extract_prior_return")
    const extracted = parseExtraction(toolBlock?.input)
    if (!extracted) return { status: "failed", error: "Extraction returned no usable data." }

    const issues = validatePriorReturn(extracted, expect)
    return {
      status: issues.length === 0 ? "validated" : "quarantined",
      extracted,
      issues,
      source,
      extracted_at: new Date().toISOString(),
    }
  } catch (e) {
    return { status: "failed", error: `Extraction failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Keep page 1 + Schedule L / M-1 / M-2 / K-1 sections from a long text layer.
 *  Exported for tests. */
export function relevantSections(text: string): string {
  const MAX = 60_000
  if (text.length <= MAX) return text
  const pieces: string[] = [text.slice(0, 6_000)] // page 1 area: form type, year, EIN
  const headings = [/Balance Sheets per Books/gi, /Analysis of Partners.{0,3} Capital Accounts/gi, /Schedule K-1/gi]
  for (const re of headings) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null && pieces.join("").length < MAX) {
      pieces.push(text.slice(Math.max(0, m.index - 500), m.index + 7_000))
    }
  }
  return pieces.join("\n…\n").slice(0, MAX)
}

export type PriorReturnCase = "A_we_filed" | "B_filed_elsewhere" | "C_first_year" | "D_never_filed"

/**
 * §5 auto-answer: do WE have the prior-year return? Checks tax_returns for a
 * 'TR Filed' row at (account, priorYear). Returns the case the wizard should
 * preselect — only Case A is decidable from our records; B/C/D remain the
 * client's answer.
 */
export async function detectPriorReturnOnFile(accountId: string, priorYear: number): Promise<{ onFile: boolean; taxReturnId: string | null }> {
  const { data, error } = await supabaseAdmin
    .from("tax_returns")
    .select("id, status")
    .eq("account_id", accountId)
    .eq("tax_year", priorYear)
    .eq("status", "TR Filed")
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to check prior return: ${error.message}`)
  return { onFile: !!data, taxReturnId: data?.id ?? null }
}

/** Persist the extraction record on the submission row (W4 column). */
export async function storePriorReturnExtraction(submissionId: string, record: PriorReturnRecord): Promise<void> {
  // prior_return_extracted is new (migration 20260611-1400) and not yet in the
  // generated database.types.ts — same untyped-client pattern as
  // lib/tax/categorization-engine.ts until the next type regeneration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { error } = await db
    .from("tax_return_submissions")
    .update({ prior_return_extracted: record })
    .eq("id", submissionId)
  if (error) throw new Error(`Failed to store prior-return extraction: ${error.message}`)
}
