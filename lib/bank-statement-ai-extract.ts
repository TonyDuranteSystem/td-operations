/**
 * AI-assisted bank-statement extraction (bank-agnostic).
 *
 * Why this exists: the hand-coded parser in bank-statement-parser.ts only
 * understands Wise. Clients bank with Wise, Mercury, Relay, Chase and others,
 * in PDF or CSV, in multiple languages. Rather than hand-code a brittle parser
 * per bank/layout (which silently breaks on a format tweak and risks misreading
 * a TAX RETURN), we send the statement to Claude — which reads PDFs natively —
 * and force a structured JSON extraction of every transaction.
 *
 * ACCURACY GUARD (mandatory for tax): the model also returns the statement's own
 * opening + closing balances. We verify opening + Σamounts ≈ closing. If it does
 * NOT reconcile, the result is flagged (reconciliation.reconciled === false) so a
 * human reviews before the numbers feed a P&L / tax return. We never silently
 * trust unreconciled AI output.
 *
 * Sign convention matches ParsedTransaction: positive = inflow, negative = outflow.
 */

import type { ParseResult, ParsedTransaction } from "./bank-statement-parser"
import { stableRowRef, dedupeRefs } from "./bank-csv-parsers"

// Same model family the in-app AI agent uses (lib/ai-agent/providers.ts).
const MODEL = "claude-sonnet-4-6"
// Output ceiling. A busy monthly statement (hundreds of rows) serializes to
// well over 8k tokens of JSON; at 8192 the model truncated mid-list and the
// statement came back empty (stop_reason=max_tokens). 32k covers ~300+ rows
// while staying far under Sonnet's 64k output limit. The reconciliation guard
// still flags any statement that overflows even this.
const MAX_TOKENS = 32000
// Reconciliation tolerance in currency units (rounding / minor fee drift).
const RECONCILE_TOLERANCE = 1.0
// Cap embedded CSV/text so we never blow the context window.
const MAX_TEXT_CHARS = 200_000

interface AiTransaction {
  date?: string
  description?: string
  counterparty?: string
  amount?: number
  currency?: string
  balance_after?: number | null
}

interface AiStatement {
  bank_name?: string
  currency?: string
  account_holder?: string
  period?: string
  opening_balance?: number | null
  closing_balance?: number | null
  transactions?: AiTransaction[]
}

const RECORD_TOOL = {
  name: "record_statement",
  description:
    "Record every transaction found in the bank statement, plus the statement's own opening and closing balances.",
  input_schema: {
    type: "object",
    properties: {
      bank_name: { type: "string", description: "Bank/provider name (e.g. Wise, Mercury, Relay, Chase). Empty if unclear." },
      currency: { type: "string", description: "Primary 3-letter currency code (e.g. USD, EUR). Empty if mixed/unclear." },
      account_holder: { type: "string", description: "Account holder / company name on the statement." },
      period: { type: "string", description: "Statement period as printed (e.g. 'Jan 1 - Dec 31, 2025')." },
      opening_balance: { type: ["number", "null"], description: "Opening/beginning balance printed on the statement, or null if not stated." },
      closing_balance: { type: ["number", "null"], description: "Closing/ending balance printed on the statement, or null if not stated." },
      transactions: {
        type: "array",
        description: "Every transaction line, in statement order.",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "Transaction date in ISO format YYYY-MM-DD." },
            description: { type: "string", description: "Full transaction description as printed." },
            counterparty: { type: "string", description: "Payer/payee name if identifiable, else empty." },
            amount: { type: "number", description: "Signed amount: POSITIVE for money IN (credit/deposit), NEGATIVE for money OUT (debit/withdrawal)." },
            currency: { type: "string", description: "3-letter currency code for this line." },
            balance_after: { type: ["number", "null"], description: "Running balance after this line, or null if not shown." },
          },
          required: ["date", "description", "amount"],
        },
      },
    },
    required: ["transactions", "opening_balance", "closing_balance"],
  },
} as const

const SYSTEM_PROMPT =
  "You are a meticulous bookkeeping assistant extracting transactions from a bank statement for a US tax return. " +
  "Extract EVERY transaction line exactly as printed — do not summarize, skip, merge, or invent rows. " +
  "Sign convention: money IN is POSITIVE, money OUT is NEGATIVE. " +
  "Use the printed running balance to keep signs correct. Report the statement's own opening and closing balances " +
  "so the extraction can be reconciled. If a value is not present, use null rather than guessing. " +
  "Always respond by calling the record_statement tool."

function emptyResult(fileName: string, errors: string[]): ParseResult {
  return {
    transactions: [],
    bank_name: "unknown",
    currency: "USD",
    account_holder: "",
    period: "",
    errors,
    extraction_method: "ai",
    reconciliation: { opening_balance: null, closing_balance: null, computed_closing: null, reconciled: null, note: `Not extracted: ${fileName}` },
  }
}

/** Build the Claude user-message content block for the file. */
function buildContent(buffer: Buffer, fileName: string, mimeType: string): unknown[] {
  const instruction = `Extract all transactions from this bank statement file: ${fileName}`
  const lower = fileName.toLowerCase()

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } },
      { type: "text", text: instruction },
    ]
  }

  // CSV / TSV / text — embed decoded text (Claude has no CSV block type).
  const text = buffer.toString("utf-8").slice(0, MAX_TEXT_CHARS)
  return [{ type: "text", text: `${instruction}\n\n--- ${fileName} ---\n${text}` }]
}

/** Compute the reconciliation verdict for the extracted statement. */
function reconcile(stmt: AiStatement, txns: ParsedTransaction[]): NonNullable<ParseResult["reconciliation"]> {
  const opening = typeof stmt.opening_balance === "number" ? stmt.opening_balance : null
  const closing = typeof stmt.closing_balance === "number" ? stmt.closing_balance : null

  // Multi-currency statements (e.g. Wise EUR+USD) can't be reconciled with a
  // single balance delta — flag as unknown rather than falsely failing.
  const currencies = Array.from(new Set(txns.map(t => t.currency).filter(Boolean)))
  if (currencies.length > 1) {
    return { opening_balance: opening, closing_balance: closing, computed_closing: null, reconciled: null, note: `Multi-currency (${currencies.join(", ")}) — balance reconciliation skipped` }
  }

  if (opening === null || closing === null) {
    return { opening_balance: opening, closing_balance: closing, computed_closing: null, reconciled: null, note: "Statement did not state opening/closing balance — cannot reconcile" }
  }

  const sum = txns.reduce((acc, t) => acc + (Number.isFinite(t.amount) ? t.amount : 0), 0)
  const computed = Math.round((opening + sum) * 100) / 100
  const reconciled = Math.abs(computed - closing) <= RECONCILE_TOLERANCE
  return {
    opening_balance: opening,
    closing_balance: closing,
    computed_closing: computed,
    reconciled,
    note: reconciled
      ? "Reconciled: opening + transactions = closing"
      : `MISMATCH: opening ${opening} + Σ ${Math.round(sum * 100) / 100} = ${computed}, but statement closing = ${closing}. Needs human review before filing.`,
  }
}

/**
 * Extract transactions from any bank statement (PDF or CSV/text) via Claude.
 * Returns a ParseResult shaped exactly like the hand-coded parsers, plus
 * `extraction_method: "ai"` and a `reconciliation` verdict.
 */
async function extractSinglePass(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  opts?: { fetchImpl?: typeof fetch; model?: string; maxAttempts?: number; budgetMs?: number },
): Promise<ParseResult> {
  // NOTE (round 3): a missing/rotated key is OUR config problem, not the
  // file's — the no-key result below is flagged transient so the job retries
  // instead of terminally branding every upload of the mishap window as
  // unreadable and notifying the clients.
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    const r = emptyResult(fileName, ["ANTHROPIC_API_KEY not configured — cannot AI-extract statement"])
    r.transient_failure = true
    return r
  }

  const doFetch = opts?.fetchImpl || fetch
  const requestBody = JSON.stringify({
    model: opts?.model || MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [RECORD_TOOL],
    tool_choice: { type: "tool", name: "record_statement" },
    messages: [{ role: "user", content: buildContent(buffer, fileName, mimeType) }],
  })

  // RELIABILITY: AI PDF extraction is non-deterministic — the SAME readable
  // statement can come back with rows on one call and empty ("could not read")
  // on another (observed on a real Chase PDF: 94 tx one attempt, 0 the next).
  // So retry on an EMPTY result or a TRANSIENT API error before giving up.
  // We do NOT retry a truncated (max_tokens) or non-empty result — those are
  // usable/known — so a successful first call still makes exactly one request.
  // A global deadline keeps all attempts inside the 300s job-worker window
  // (one statement per ingest job); per-attempt timeout is the smaller of 240s
  // and the remaining budget. A genuinely unreadable (e.g. scanned) PDF still
  // ends empty after the retries and is surfaced for human review.
  const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])
  const MAX_ATTEMPTS = opts?.maxAttempts ?? 3
  const GLOBAL_DEADLINE_MS = opts?.budgetMs ?? 250_000
  const PER_ATTEMPT_MS = 240_000
  const startedAt = Date.now()
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const txCountOf = (d: { content?: Array<{ type: string; name?: string; input?: AiStatement }> } | null) => {
    const tb = (d?.content || []).find(b => b.type === "tool_use" && b.name === "record_statement")
    const t = (tb?.input as AiStatement | undefined)?.transactions
    return Array.isArray(t) ? t.length : 0
  }

  let data: { content?: Array<{ type: string; name?: string; input?: AiStatement }>; stop_reason?: string } | null = null
  let lastError: string | null = null
  const retryNotes: string[] = []
  // Card 4a39e0fd round 2: when we end with NO usable response and the causes
  // were transport-level (transient API status / request exception), the
  // caller must job-level retry — this is NOT an unreadable file. A permanent
  // API rejection (e.g. 400) stays non-transient: retrying can't help.
  let sawTransportFailure = false

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = GLOBAL_DEADLINE_MS - (Date.now() - startedAt)
    if (attempt > 1 && remaining < 15_000) break // not enough budget for another real try
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(PER_ATTEMPT_MS, Math.max(remaining, 15_000)))
    try {
      const res = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: requestBody,
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        lastError = `Claude API error ${res.status}: ${JSON.stringify(err)}`
        if (!TRANSIENT.has(res.status)) { data = null; sawTransportFailure = false; break } // permanent (e.g. 400) — retry won't help
        sawTransportFailure = true
        retryNotes.push(`attempt ${attempt}: API ${res.status}`)
      } else {
        const attemptData = await res.json()
        // Usable result (has rows) or a truncation we must flag — take it, stop.
        if (txCountOf(attemptData) > 0 || attemptData.stop_reason === "max_tokens") { data = attemptData; break }
        // Empty (0 rows, not truncated): keep as fallback, retry the flaky read.
        data = attemptData
        lastError = "AI extraction returned no transactions"
        retryNotes.push(`attempt ${attempt}: 0 transactions`)
      }
    } catch (e) {
      lastError = `AI extraction request failed: ${e instanceof Error ? e.message : String(e)}`
      sawTransportFailure = true
      retryNotes.push(`attempt ${attempt}: ${e instanceof Error ? e.message : "request error"}`)
    } finally {
      clearTimeout(timeout)
    }
    if (attempt < MAX_ATTEMPTS && GLOBAL_DEADLINE_MS - (Date.now() - startedAt) > 15_000) {
      await sleep(1000 * attempt) // 1s, then 2s backoff
    }
  }

  if (!data) {
    const r = emptyResult(fileName, [lastError || "AI extraction failed"])
    // No usable response at all + transport-level causes → the caller must
    // retry the JOB; the file was never actually read. (A model that DID
    // answer with zero rows takes the `data` path below and stays a genuine
    // could-not-read.)
    if (sawTransportFailure) r.transient_failure = true
    return r
  }

  const errors: string[] = []
  // Surface that retries happened (helps explain a flaky-but-recovered read).
  if (retryNotes.length > 0 && txCountOf(data) > 0) {
    errors.push(`Recovered after retry (${retryNotes.join("; ")}).`)
  }
  // max_tokens truncation means the transaction list is incomplete — must flag.
  if (data.stop_reason === "max_tokens") {
    errors.push("AI response hit max_tokens — transaction list may be TRUNCATED. Needs human review.")
  }

  const toolBlock = (data.content || []).find(b => b.type === "tool_use" && b.name === "record_statement")
  const stmt: AiStatement = (toolBlock?.input as AiStatement) || {}
  const rawTxns = Array.isArray(stmt.transactions) ? stmt.transactions : []

  const fallbackCurrency = (stmt.currency || "USD").toUpperCase()
  const transactions: ParsedTransaction[] = rawTxns
    .filter(t => t && typeof t.amount === "number" && t.date)
    .map(t => {
      const currency = (t.currency || fallbackCurrency).toUpperCase()
      const date = String(t.date).slice(0, 10)
      const description = (t.description || "").trim()
      return {
        transaction_date: date,
        description,
        counterparty: (t.counterparty || "").trim(),
        amount: t.amount as number,
        currency,
        balance_after: typeof t.balance_after === "number" ? t.balance_after : null,
        // Deterministic content-hash ref (master plan W3): the same row must
        // produce the same ref no matter which run, chunk, or ingestion path
        // extracts it — that's what makes re-ingestion collide harmlessly on
        // the dedup unique index. The old `ai-<date>-<index>` was order-
        // dependent and broke that guarantee.
        transaction_ref: stableRowRef([date, t.amount as number, description, t.balance_after ?? ""]),
        bank_name: stmt.bank_name || "unknown",
        account_type: currency,
      }
    })
  // Stable -2/-3… suffixes for genuinely identical rows within one statement.
  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })

  if (transactions.length === 0 && errors.length === 0) {
    errors.push("AI extraction returned no transactions")
  }

  return {
    transactions,
    bank_name: stmt.bank_name || "unknown",
    currency: fallbackCurrency,
    account_holder: stmt.account_holder || "",
    period: stmt.period || "",
    errors,
    extraction_method: "ai",
    reconciliation: reconcile(stmt, transactions),
  }
}

// ── Large-PDF chunking ──────────────────────────────────────────────────────
// A full-year statement delivered as ONE big PDF (e.g. a 60-page Chase export)
// is under-read by a single pass — the model reliably extracts a few pages and
// drops the rest (observed in real-data QA: 94 of ~521 tx). Split a large PDF
// into page-windows, extract each, and MERGE. Small statements (≤ threshold
// pages) are untouched — exactly the proven single pass. Document AI OCR is NOT
// used: the content is already machine-readable text, and DocAI's sync API caps
// at 30 pages anyway (Phase-0 finding, 2026-06-27).
const CHUNK_THRESHOLD_PAGES = 15
const CHUNK_PAGES = 10

/** Split a PDF into ≤CHUNK_PAGES-page sub-PDFs. Returns null when the PDF has
 *  ≤ threshold pages OR cannot be parsed → caller falls back to a single pass
 *  (today's behavior); chunking never makes a readable file worse. */
async function splitPdfIntoChunks(buffer: Buffer): Promise<Buffer[] | null> {
  try {
    const { PDFDocument } = await import("pdf-lib")
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const n = src.getPageCount()
    if (n <= CHUNK_THRESHOLD_PAGES) return null
    const chunks: Buffer[] = []
    for (let start = 0; start < n; start += CHUNK_PAGES) {
      const out = await PDFDocument.create()
      const idxs: number[] = []
      for (let i = start; i < Math.min(start + CHUNK_PAGES, n); i++) idxs.push(i)
      const pages = await out.copyPages(src, idxs)
      pages.forEach(p => out.addPage(p))
      chunks.push(Buffer.from(await out.save()))
    }
    return chunks.length > 1 ? chunks : null
  } catch {
    return null // unparseable / encrypted / odd PDF → single pass
  }
}

/**
 * Extract transactions from any bank statement (PDF or CSV/text) via Claude.
 * A LARGE multi-page PDF is split into page-chunks, each extracted, then merged
 * (chunk fan-out for one oversized file); everything else is a single pass.
 */
export async function aiExtractBankStatement(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  opts?: { fetchImpl?: typeof fetch; model?: string },
): Promise<ParseResult> {
  const isPdf = mimeType === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")
  const chunks = isPdf ? await splitPdfIntoChunks(buffer) : null
  if (!chunks) return extractSinglePass(buffer, fileName, mimeType, opts) // proven single pass

  // Keep the whole chunked extraction inside the 300s job window: spread ~220s
  // across chunks (≥25s each, ceiling not actual), hard-stop at 250s elapsed.
  const perChunkBudget = Math.max(25_000, Math.floor(220_000 / chunks.length))
  const maxAttempts = chunks.length <= 4 ? 2 : 1
  const results: ParseResult[] = []
  const startedAll = Date.now()
  let truncatedChunks = 0
  for (let i = 0; i < chunks.length; i++) {
    if (Date.now() - startedAll > 250_000) { truncatedChunks = chunks.length - i; break }
    results.push(await extractSinglePass(chunks[i], `${fileName}#chunk${i + 1}`, "application/pdf",
      { ...opts, maxAttempts, budgetMs: perChunkBudget }))
  }

  // Merge: concat, re-dedupe refs across the COMBINED set (page windows don't
  // overlap, so this only collapses genuinely-identical rows). Reconcile against
  // the FULL statement: first chunk's opening, last chunk's closing, Σ all.
  const mergedTx = results.flatMap(r => r.transactions)
  const combinedRefs = dedupeRefs(mergedTx.map(t => t.transaction_ref))
  mergedTx.forEach((t, i) => { t.transaction_ref = combinedRefs[i] })

  const opening = results[0]?.reconciliation?.opening_balance ?? null
  const closing = results[results.length - 1]?.reconciliation?.closing_balance ?? null
  const currencies = Array.from(new Set(mergedTx.map(t => t.currency).filter(Boolean)))
  let reconciliation: NonNullable<ParseResult["reconciliation"]>
  if (currencies.length > 1) {
    reconciliation = { opening_balance: opening, closing_balance: closing, computed_closing: null, reconciled: null, note: `Multi-currency (${currencies.join(", ")}) across ${chunks.length} page-chunks — reconciliation skipped` }
  } else if (opening === null || closing === null) {
    reconciliation = { opening_balance: opening, closing_balance: closing, computed_closing: null, reconciled: null, note: `Multi-page PDF (${chunks.length} chunks): opening/closing not both stated — cannot reconcile` }
  } else {
    const sum = mergedTx.reduce((a, t) => a + (Number.isFinite(t.amount) ? t.amount : 0), 0)
    const computed = Math.round((opening + sum) * 100) / 100
    const reconciled = Math.abs(computed - closing) <= RECONCILE_TOLERANCE
    reconciliation = { opening_balance: opening, closing_balance: closing, computed_closing: computed, reconciled, note: reconciled ? `Reconciled across ${chunks.length} page-chunks` : `MISMATCH across ${chunks.length} page-chunks: opening ${opening} + Σ ${Math.round(sum * 100) / 100} = ${computed}, statement closing = ${closing}. Needs human review.` }
  }

  const errors = Array.from(new Set(results.flatMap(r => r.errors)))
  errors.unshift(`Large PDF split into ${chunks.length} page-chunks (>${CHUNK_THRESHOLD_PAGES} pages) and merged.`)
  if (truncatedChunks > 0) errors.push(`Time budget reached — ${truncatedChunks} chunk(s) not processed; figures may be incomplete (see reconciliation).`)
  if (mergedTx.length === 0) errors.push("AI extraction returned no transactions across any chunk")

  return {
    transactions: mergedTx,
    bank_name: results.find(r => r.bank_name && r.bank_name !== "unknown")?.bank_name || "unknown",
    currency: results[0]?.currency || "USD",
    account_holder: results.find(r => r.account_holder)?.account_holder || "",
    period: results.find(r => r.period)?.period || "",
    errors,
    extraction_method: "ai",
    reconciliation,
  }
}
