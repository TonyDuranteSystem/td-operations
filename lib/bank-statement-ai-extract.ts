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

// Same model family the in-app AI agent uses (lib/ai-agent/providers.ts).
const MODEL = "claude-sonnet-4-6"
// Generous ceiling: a monthly statement rarely exceeds a few hundred rows.
const MAX_TOKENS = 8192
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
export async function aiExtractBankStatement(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  opts?: { fetchImpl?: typeof fetch; model?: string },
): Promise<ParseResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return emptyResult(fileName, ["ANTHROPIC_API_KEY not configured — cannot AI-extract statement"])

  const doFetch = opts?.fetchImpl || fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  let data: { content?: Array<{ type: string; name?: string; input?: AiStatement }>; stop_reason?: string }
  try {
    const res = await doFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts?.model || MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [RECORD_TOOL],
        tool_choice: { type: "tool", name: "record_statement" },
        messages: [{ role: "user", content: buildContent(buffer, fileName, mimeType) }],
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return emptyResult(fileName, [`Claude API error ${res.status}: ${JSON.stringify(err)}`])
    }
    data = await res.json()
  } catch (e) {
    return emptyResult(fileName, [`AI extraction request failed: ${e instanceof Error ? e.message : String(e)}`])
  } finally {
    clearTimeout(timeout)
  }

  const errors: string[] = []
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
    .map((t, i) => {
      const currency = (t.currency || fallbackCurrency).toUpperCase()
      return {
        transaction_date: String(t.date).slice(0, 10),
        description: (t.description || "").trim(),
        counterparty: (t.counterparty || "").trim(),
        amount: t.amount as number,
        currency,
        balance_after: typeof t.balance_after === "number" ? t.balance_after : null,
        transaction_ref: `ai-${String(t.date).slice(0, 10)}-${i}`,
        bank_name: stmt.bank_name || "unknown",
        account_type: currency,
      }
    })

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
