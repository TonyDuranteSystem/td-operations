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

export type CsvBankSignature = "wise" | "relay" | "mercury" | "revolut" | "slash" | "wise_transfers" | null

/** Identify the bank from the HEADER ROW content. Never trust filenames or
 *  the client's typed bank label — clients mislabel. Every signature below is
 *  built from a REAL client export (verified 2026-06-10/11). */
export function detectCsvSignature(headerCells: string[]): CsvBankSignature {
  const h = headerCells.map(c => c.trim().toLowerCase())
  const has = (...names: string[]) => names.every(n => h.includes(n))
  // Relay: Date,Payee,Transaction Type,Description,Reference,Status,Amount,Currency,Balance
  if (has("date", "payee", "transaction type", "status", "amount")) return "relay"
  // Mercury: Date (UTC),Description,Amount,Status,Source Account,…,Mercury Category,…
  if (has("date (utc)", "amount") && h.includes("mercury category")) return "mercury"
  // Revolut Business: Date started (UTC),Date completed (UTC),ID,Type,State,…,Total amount,…
  if (h.includes("date started (utc)") && h.includes("state") && h.includes("total amount")) return "revolut"
  // Slash: "Timestamp","Type","Description","Amount","Balance" (exactly these five)
  if (has("timestamp", "type", "description", "amount", "balance") && h.length <= 6) return "slash"
  // Wise TRANSFERS export (different from the balance statement!): ID,Status,Direction,Source/Target…
  // Not deterministically parsed yet (source/target semantics) → AI fallback, and the
  // review screen must warn about double-counting if a client uploads BOTH variants.
  if (has("id", "status", "direction") && h.some(c => c.includes("source amount"))) return "wise_transfers"
  // Wise balance statement: TransferWise ID / Wise ID + Running Balance (EN/IT)
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

// ─── Mercury parser ─────────────────────────────────────────

/** MM-DD-YYYY (Mercury/Revolut US exports) or ISO → ISO. Null if unparseable. */
function usDashDateToIso(raw: string): string | null {
  const t = raw.trim()
  const m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/)
  if (m) {
    const month = Number(m[1]), day = Number(m[2])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  return null
}

/**
 * Parse a Mercury CSV export.
 * Real columns (verified 2026-06-11): Date (UTC), Description, Amount, Status,
 * Source Account, Bank Description, Reference, Note, Last Four Digits,
 * Name On Card, Mercury Category, Category, GL Code, Timestamp,
 * Original Currency, Check Number, Tags, Cardholder Email, Tracking ID.
 *
 * - Dates are MM-DD-YYYY. Amounts are signed. No running balance column.
 * - Only Status === "Sent" rows are booked (others: Pending/Failed/Cancelled).
 * - "Mercury Category" is kept in the description tail — a free
 *   categorization signal for the engine.
 */
export function parseMercuryCSV(csvContent: string, _fileName: string): ParseResult {
  const errors: string[] = []
  const dialect = sniffCsvDialect(csvContent)
  const rows = parseDelimitedRows(csvContent, dialect.delimiter)
  if (rows.length < 2) {
    return { transactions: [], bank_name: "Mercury", currency: "USD", account_holder: "", period: "", errors: ["Empty CSV"] }
  }

  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const cDate = col("date (utc)"), cDesc = col("description"), cAmount = col("amount"),
    cStatus = col("status"), cSource = col("source account"), cBankDesc = col("bank description"),
    cMercCat = col("mercury category"), cCurrency = col("original currency")

  if (cDate === -1 || cAmount === -1) {
    return { transactions: [], bank_name: "Mercury", currency: "USD", account_holder: "", period: "", errors: ["Could not find required columns (date, amount)"] }
  }

  const transactions: ParsedTransaction[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const status = (cStatus !== -1 ? row[cStatus] : "Sent")?.trim().toLowerCase()
    if (status && status !== "sent") { skipped++; continue }
    const iso = usDashDateToIso(row[cDate] ?? "")
    if (!iso) { errors.push(`Unparseable date: "${row[cDate]}"`); continue }
    const amount = parseAmount(row[cAmount] ?? "", dialect.commaDecimals)
    if (isNaN(amount)) { errors.push(`Unparseable amount: "${row[cAmount]}" (${iso})`); continue }

    const desc = (cDesc !== -1 ? row[cDesc] : "")?.trim() ?? ""
    const bankDesc = (cBankDesc !== -1 ? row[cBankDesc] : "")?.trim() ?? ""
    const mercCat = (cMercCat !== -1 ? row[cMercCat] : "")?.trim() ?? ""
    const source = (cSource !== -1 ? row[cSource] : "")?.trim() ?? ""

    transactions.push({
      transaction_date: iso,
      description: [desc, bankDesc, mercCat ? `[${mercCat}]` : ""].filter(Boolean).join(" | ") || "Mercury transaction",
      counterparty: bankDesc || desc,
      amount,
      currency: (cCurrency !== -1 && row[cCurrency]?.trim()) || "USD",
      balance_after: null, // Mercury CSV exports carry no running balance
      transaction_ref: stableRowRef([iso, amount, desc, bankDesc, source]),
      bank_name: "Mercury",
      account_type: source || "USD",
    })
  }
  if (skipped > 0) errors.push(`Skipped ${skipped} non-Sent row(s)`)

  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })

  const dates = transactions.map(t => t.transaction_date).sort()
  return {
    transactions, bank_name: "Mercury",
    currency: transactions[0]?.currency || "USD",
    account_holder: "", period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    errors,
  }
}

// ─── Revolut Business parser ────────────────────────────────

/**
 * Parse a Revolut Business CSV export ("account-statement_*.csv").
 * Real columns (verified 2026-06-11): Date started (UTC), Date completed (UTC),
 * ID, Type, State, Description, Reference, Payer, …, Orig currency,
 * Orig amount, Payment currency, Amount, Total amount, Exchange rate, Fee,
 * Fee currency, Balance, Account, …
 *
 * - Only State === "COMPLETED" rows are booked.
 * - The booked movement is "Total amount" (amount incl. fee — it is what the
 *   running Balance reflects); plain "Amount" excludes the fee.
 * - ID is a genuine unique transaction id → used as the ref directly.
 */
export function parseRevolutCSV(csvContent: string, _fileName: string): ParseResult {
  const errors: string[] = []
  const dialect = sniffCsvDialect(csvContent)
  const rows = parseDelimitedRows(csvContent, dialect.delimiter)
  if (rows.length < 2) {
    return { transactions: [], bank_name: "Revolut", currency: "USD", account_holder: "", period: "", errors: ["Empty CSV"] }
  }

  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const cDate = col("date completed (utc)") !== -1 ? col("date completed (utc)") : col("date started (utc)")
  const cId = col("id"), cType = col("type"), cState = col("state"), cDesc = col("description"),
    cRef = col("reference"), cPayer = col("payer"),
    cTotal = col("total amount"), cAmount = col("amount"),
    cCurrency = col("payment currency"), cBalance = col("balance"), cAccount = col("account")

  if (cDate === -1 || (cTotal === -1 && cAmount === -1)) {
    return { transactions: [], bank_name: "Revolut", currency: "USD", account_holder: "", period: "", errors: ["Could not find required columns (date, amount)"] }
  }

  const transactions: ParsedTransaction[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const state = (cState !== -1 ? row[cState] : "COMPLETED")?.trim().toUpperCase()
    if (state && state !== "COMPLETED") { skipped++; continue }
    const iso = usDashDateToIso(row[cDate] ?? "")
    if (!iso) { errors.push(`Unparseable date: "${row[cDate]}"`); continue }
    const amountRaw = cTotal !== -1 && row[cTotal]?.trim() ? row[cTotal] : row[cAmount]
    const amount = parseAmount(amountRaw ?? "", dialect.commaDecimals)
    if (isNaN(amount)) { errors.push(`Unparseable amount: "${amountRaw}" (${iso})`); continue }

    const desc = (cDesc !== -1 ? row[cDesc] : "")?.trim() ?? ""
    const type = (cType !== -1 ? row[cType] : "")?.trim() ?? ""
    const payer = (cPayer !== -1 ? row[cPayer] : "")?.trim() ?? ""
    const ref = (cRef !== -1 ? row[cRef] : "")?.trim() ?? ""
    const id = (cId !== -1 ? row[cId] : "")?.trim() ?? ""
    const balanceRaw = cBalance !== -1 ? row[cBalance]?.trim() : ""
    const balance = balanceRaw ? parseAmount(balanceRaw, dialect.commaDecimals) : null
    const currency = (cCurrency !== -1 && row[cCurrency]?.trim()) || "USD"

    transactions.push({
      transaction_date: iso,
      description: [desc, type, ref].filter(Boolean).join(" | ") || "Revolut transaction",
      counterparty: payer || desc,
      amount,
      currency,
      balance_after: balance !== null && !isNaN(balance) ? balance : null,
      transaction_ref: id || stableRowRef([iso, amount, desc, balanceRaw]),
      bank_name: "Revolut",
      account_type: (cAccount !== -1 && row[cAccount]?.trim()) || currency,
    })
  }
  if (skipped > 0) errors.push(`Skipped ${skipped} non-COMPLETED row(s)`)

  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })

  const dates = transactions.map(t => t.transaction_date).sort()
  return {
    transactions, bank_name: "Revolut",
    currency: transactions[0]?.currency || "USD",
    account_holder: "", period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    errors,
  }
}

// ─── Slash parser ───────────────────────────────────────────

const SLASH_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Parse a Slash CSV export.
 * Real columns (verified 2026-06-11): "Timestamp","Type","Description",
 * "Amount","Balance" — with three quirks carved from the real file:
 * - Timestamp is "Dec 30" with NO YEAR. The year comes from `fallbackYear`
 *   (the tax year the wizard knows), corroborated by MM.DD.YY dates embedded
 *   in Slash fee descriptions ("…for 12.28.25") when present.
 * - An EMPTY Timestamp means "same date as the row above" (the file is in
 *   descending date order).
 * - Year boundary while descending: when the month jumps UP (Jan → Dec), the
 *   year decrements.
 */
export function parseSlashCSV(csvContent: string, _fileName: string, opts?: { fallbackYear?: number }): ParseResult {
  const errors: string[] = []
  const dialect = sniffCsvDialect(csvContent)
  const rows = parseDelimitedRows(csvContent, dialect.delimiter)
  if (rows.length < 2) {
    return { transactions: [], bank_name: "Slash", currency: "USD", account_holder: "", period: "", errors: ["Empty CSV"] }
  }

  const header = rows[0].map(h => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  const cTs = col("timestamp"), cType = col("type"), cDesc = col("description"),
    cAmount = col("amount"), cBalance = col("balance")
  if (cTs === -1 || cAmount === -1) {
    return { transactions: [], bank_name: "Slash", currency: "USD", account_holder: "", period: "", errors: ["Could not find required columns (timestamp, amount)"] }
  }

  // Year anchor: explicit option, else first embedded MM.DD.YY in a fee line.
  let year = opts?.fallbackYear ?? null
  if (year === null) {
    for (const row of rows.slice(1)) {
      const m = (row[cDesc] ?? "").match(/\b\d{1,2}\.\d{1,2}\.(\d{2})\b/)
      if (m) { year = 2000 + Number(m[1]); break }
    }
  }
  if (year === null) {
    return { transactions: [], bank_name: "Slash", currency: "USD", account_holder: "", period: "", errors: ["Slash dates carry no year — pass fallbackYear (tax year) to parse this file"] }
  }

  const transactions: ParsedTransaction[] = []
  let prevMonth: number | null = null
  let currentIso: string | null = null

  for (const row of rows.slice(1)) {
    const tsRaw = (row[cTs] ?? "").trim()
    if (tsRaw !== "") {
      const m = tsRaw.match(/^([A-Za-z]{3,})\s+(\d{1,2})$/)
      if (!m) { errors.push(`Unparseable timestamp: "${tsRaw}"`); continue }
      const month = SLASH_MONTHS[m[1].slice(0, 3).toLowerCase()]
      const day = Number(m[2])
      if (!month || day < 1 || day > 31) { errors.push(`Unparseable timestamp: "${tsRaw}"`); continue }
      // Descending file: a month jump UPWARD (Jan → Dec) crosses into the prior year.
      if (prevMonth !== null && month > prevMonth) year!--
      prevMonth = month
      currentIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }
    if (!currentIso) { errors.push("Row before any dated row — skipped"); continue }

    const amount = parseAmount(row[cAmount] ?? "", dialect.commaDecimals)
    if (isNaN(amount)) { errors.push(`Unparseable amount: "${row[cAmount]}" (${currentIso})`); continue }
    const type = (cType !== -1 ? row[cType] : "")?.trim() ?? ""
    const desc = (cDesc !== -1 ? row[cDesc] : "")?.trim() ?? ""
    const balanceRaw = cBalance !== -1 ? row[cBalance]?.trim() : ""
    const balance = balanceRaw ? parseAmount(balanceRaw, dialect.commaDecimals) : null

    transactions.push({
      transaction_date: currentIso,
      description: [type, desc].filter(Boolean).join(" | ") || "Slash transaction",
      counterparty: desc,
      amount,
      currency: "USD",
      balance_after: balance !== null && !isNaN(balance) ? balance : null,
      transaction_ref: stableRowRef([currentIso, amount, type, desc, balanceRaw]),
      bank_name: "Slash",
      account_type: "USD",
    })
  }

  const refs = dedupeRefs(transactions.map(t => t.transaction_ref))
  transactions.forEach((t, i) => { t.transaction_ref = refs[i] })

  const dates = transactions.map(t => t.transaction_date).sort()
  return {
    transactions, bank_name: "Slash", currency: "USD",
    account_holder: "", period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "",
    errors,
  }
}
