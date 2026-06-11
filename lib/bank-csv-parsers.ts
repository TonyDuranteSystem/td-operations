/**
 * Bank CSV parsing — content-signature detection + per-bank parsers.
 * Master plan (sysdoc tax-financials-self-service-master-plan) §10.4.
 *
 * Detection is CONTENT-based (header signature), never label-based — the
 * client's free-text bank name is only a display label (§2.5). Known
 * signatures parse deterministically (exact, instant, free); unknown layouts
 * fall back to AI-CSV extraction in parseBankStatement.
 *
 * Two cross-cutting guarantees live here:
 * - Dialect sniffing: clients re-save bank CSVs through Excel, which (in the
 *   Italian locale) turns them into semicolon-delimited files with comma
 *   decimals. The sniffer detects that before any parser runs.
 * - Deterministic row refs: `transaction_ref` is the dedup identity
 *   (unique index + NOT NULL/non-blank since migration 20260611-1400). When a
 *   CSV has no genuinely unique reference column, the ref is a stable hash of
 *   the row's content — the same row always produces the same ref, no matter
 *   which ingestion path or run processes it (master plan W2/W3).
 */

import { createHash } from "crypto"
import type { ParsedTransaction, ParseResult } from "./bank-statement-parser"

// ─── Deterministic row refs ─────────────────────────────────

/** Stable content hash for a transaction row. Same inputs → same ref, across
 *  runs, chunks, and ingestion paths (CSV parser, AI extractor, re-uploads). */
export function stableRowRef(parts: Array<string | number | null | undefined>): string {
  const key = parts.map(p => String(p ?? "")).join("|")
  return "h-" + createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/** Disambiguate genuinely identical rows within one file (same date, amount,
 *  description AND balance — e.g. two equal card charges with no balance
 *  column). The N-th duplicate gets a stable -2/-3… suffix, so re-parsing the
 *  same file yields the same refs in the same order. */
export function dedupeRefs(refs: string[]): string[] {
  const seen = new Map<string, number>()
  return refs.map(ref => {
    const n = (seen.get(ref) ?? 0) + 1
    seen.set(ref, n)
    return n === 1 ? ref : `${ref}-${n}`
  })
}

// ─── CSV dialect sniffing (Excel re-save contamination) ─────

export interface CsvDialect {
  delimiter: "," | ";"
  /** true when amounts use comma decimals (Italian Excel re-save) */
  commaDecimals: boolean
}

/** Sniff delimiter + decimal convention from the raw content. Semicolon wins
 *  when the first line contains more `;` than `,` — the signature of an
 *  Italian-locale Excel re-save (which also writes 1.234,56 amounts). */
export function sniffCsvDialect(content: string): CsvDialect {
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? content.length : content.indexOf("\n"))
  const semis = (firstLine.match(/;/g) || []).length
  const commas = (firstLine.match(/,/g) || []).length
  const delimiter = semis > commas ? ";" : ","
  // Comma decimals: look for ;-delimited files with 123,45-style numbers, or
  // explicit 1.234,56 patterns anywhere in the first few lines.
  const sample = content.slice(0, 2000)
  const commaDecimals = delimiter === ";"
    ? /(^|;|")-?\d+,\d{2}($|;|")/m.test(sample) || /\d+\.\d{3},\d{2}/.test(sample)
    : /\d+\.\d{3},\d{2}/.test(sample)
  return { delimiter, commaDecimals }
}

/** Parse rows honoring the sniffed delimiter, handling quoted fields. */
export function parseDelimitedRows(csv: string, delimiter: "," | ";"): string[][] {
  const rows: string[][] = []
  const lines = csv.split("\n")
  let currentRow: string[] = []
  let inQuote = false
  let currentField = ""

  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') {
          currentField += '"'
          i++
        } else if (ch === '"') {
          inQuote = false
        } else {
          currentField += ch
        }
      } else {
        if (ch === '"') {
          inQuote = true
        } else if (ch === delimiter) {
          currentRow.push(currentField)
          currentField = ""
        } else {
          currentField += ch
        }
      }
    }
    if (inQuote) {
      currentField += "\n"
    } else {
      currentRow.push(currentField)
      currentField = ""
      if (currentRow.some(f => f.trim() !== "")) rows.push(currentRow)
      currentRow = []
    }
  }
  if (currentRow.length > 0 || currentField) {
    currentRow.push(currentField)
    if (currentRow.some(f => f.trim() !== "")) rows.push(currentRow)
  }
  return rows
}

// ─── Content-signature detection ────────────────────────────

export type CsvBankSignature = "wise" | "relay" | null

/** Identify the bank from the HEADER ROW content. Never trust filenames or
 *  the client's typed bank label — clients mislabel. */
export function detectCsvSignature(headerCells: string[]): CsvBankSignature {
  const h = headerCells.map(c => c.trim().toLowerCase())
  const has = (...names: string[]) => names.every(n => h.includes(n))
  // Relay export: Date,Payee,Transaction Type,Description,Reference,Status,Amount,Currency,Balance
  if (has("date", "payee", "transaction type", "status", "amount")) return "relay"
  // Wise export: TransferWise ID / Wise ID + Running Balance variants (EN/IT)
  if (h.some(c => c === "transferwise id" || c === "wise id") || has("date", "amount") && h.some(c => c.includes("running balance") || c.includes("saldo corrente"))) return "wise"
  return null
}

// ─── Relay parser ───────────────────────────────────────────

/** Convert Relay's US-style M/D/YYYY to ISO. Returns null when unparseable.
 *  NEVER reuse the Wise parser's D/M/YYYY assumption here (verified against
 *  real Relay exports 2026-06-10: "1/30/2025" = January 30). */
function relayDateToIso(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const [, mo, d, y] = m
    const month = Number(mo), day = Number(d)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw.trim())) return raw.trim().slice(0, 10)
  return null
}

function parseAmount(raw: string, commaDecimals: boolean): number {
  let s = raw.trim().replace(/[+$€£\s]/g, "")
  if (commaDecimals) s = s.replace(/\./g, "").replace(",", ".")
  else s = s.replace(/,/g, "")
  const n = parseFloat(s)
  return isNaN(n) ? NaN : n
}

/**
 * Parse a Relay Financial CSV export.
 * Real columns (verified 2026-06-10): Date, Payee, Transaction Type,
 * Description, Reference, Status, Amount, Currency, Balance.
 *
 * Notes carved from the real files:
 * - Dates are M/D/YYYY (US).
 * - Amounts are signed, inflows often prefixed "+".
 * - The Reference column is NOT a unique transaction id (values like
 *   "paypal" or "Corporate Card - 6921") — refs are content hashes instead.
 * - Only SETTLED rows are counted; pending rows would double-count once they
 *   settle in a later export.
 */
export function parseRelayCSV(csvContent: string, _fileName: string): ParseResult {
  const errors: string[] = []
  const dialect = sniffCsvDialect(csvContent)
  const rows = parseDelimitedRows(csvContent, dialect.delimiter)
  if (rows.length < 2) {
    return { transactions: [], bank_name: "Relay", currency: "USD", account_holder: "", period: "", errors: ["Empty CSV"] }
  }

  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const cDate = col("date"), cPayee = col("payee"), cType = col("transaction type"),
    cDesc = col("description"), cRef = col("reference"), cStatus = col("status"),
    cAmount = col("amount"), cCurrency = col("currency"), cBalance = col("balance")

  if (cDate === -1 || cAmount === -1) {
    return { transactions: [], bank_name: "Relay", currency: "USD", account_holder: "", period: "", errors: ["Could not find required columns (date, amount)"] }
  }

  const transactions: ParsedTransaction[] = []
  let skippedUnsettled = 0
  for (const row of rows.slice(1)) {
    const status = (cStatus !== -1 ? row[cStatus] : "SETTLED")?.trim().toUpperCase()
    if (status && status !== "SETTLED") { skippedUnsettled++; continue }

    const iso = relayDateToIso(row[cDate] ?? "")
    if (!iso) { errors.push(`Unparseable date: "${row[cDate]}"`); continue }
    const amount = parseAmount(row[cAmount] ?? "", dialect.commaDecimals)
    if (isNaN(amount)) { errors.push(`Unparseable amount: "${row[cAmount]}" (${iso})`); continue }

    const payee = (cPayee !== -1 ? row[cPayee] : "")?.trim() ?? ""
    const descParts = [payee, cType !== -1 ? row[cType]?.trim() : "", cDesc !== -1 ? row[cDesc]?.trim() : "", cRef !== -1 ? row[cRef]?.trim() : ""]
      .filter(p => p && p.toLowerCase() !== "unknown")
    const balanceRaw = cBalance !== -1 ? row[cBalance]?.trim() : ""
    const balance = balanceRaw ? parseAmount(balanceRaw, dialect.commaDecimals) : null

    transactions.push({
      transaction_date: iso,
      description: descParts.join(" | ") || "Relay transaction",
      counterparty: payee,
      amount,
      currency: (cCurrency !== -1 && row[cCurrency]?.trim()) || "USD",
      balance_after: balance !== null && !isNaN(balance) ? balance : null,
      // content hash incl. running balance (distinguishes equal twin charges)
      transaction_ref: stableRowRef([iso, amount, payee, row[cDesc] ?? "", balanceRaw]),
      bank_name: "Relay",
      account_type: (cCurrency !== -1 && row[cCurrency]?.trim()) || "USD",
    })
  }
  if (skippedUnsettled > 0) errors.push(`Skipped ${skippedUnsettled} non-SETTLED row(s) — they are counted when they settle`)

  // stable -2/-3 suffixes for genuinely identical rows
  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })

  const dates = transactions.map(t => t.transaction_date).sort()
  return {
    transactions,
    bank_name: "Relay",
    currency: transactions[0]?.currency || "USD",
    account_holder: "",
    period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    errors,
  }
}
