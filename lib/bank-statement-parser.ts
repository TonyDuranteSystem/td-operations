/**
 * Bank Statement Parser
 * Parses CSV and PDF bank statements. CSV-first approach (structured data),
 * AI extraction as the universal fallback.
 *
 * Hand-coded (exact, free) formats, routed by content signature
 * (lib/bank-csv-parsers.ts): Wise CSV (EUR/USD, IT & EN), Relay CSV,
 * Wise PDF (legacy fallback). Everything else → AI extraction with the
 * reconciliation guard (lib/bank-statement-ai-extract.ts).
 */

import { sniffCsvDialect, parseDelimitedRows, detectCsvSignature, parseRelayCSV, parseMercuryCSV, parseRevolutCSV, parseSlashCSV, parseGenericCSV, stableRowRef } from "./bank-csv-parsers"

// ─── Types ──────────────────────────────────────────────────

export interface ParsedTransaction {
  transaction_date: string // YYYY-MM-DD
  description: string
  counterparty: string
  amount: number // positive = inflow, negative = outflow
  currency: string
  balance_after: number | null
  transaction_ref: string
  bank_name: string
  account_type: string // EUR, USD
}

export interface CategorizedTransaction extends ParsedTransaction {
  // "contribution" = owner/member money INTO the company (capital contribution).
  // It feeds the capital account roll-forward, NEVER the P&L — counting it as
  // income overstates revenue on a tax return (flaw F3, master plan §4).
  category: "income" | "cogs" | "expense" | "distribution" | "contribution" | "fee" | "conversion" | "refund" | "uncategorized"
  subcategory: string
  is_related_party: boolean
  notes: string
}

export interface ParseResult {
  transactions: ParsedTransaction[]
  bank_name: string
  currency: string
  account_holder: string
  period: string
  errors: string[]
  /** How the transactions were extracted. Absent for legacy hand-coded parsers. */
  extraction_method?: "wise_csv" | "relay_csv" | "mercury_csv" | "revolut_csv" | "slash_csv" | "generic_csv" | "wise_pdf" | "ai" | "unknown"
  /**
   * Balance reconciliation guard (set by AI extraction). When a statement
   * reports opening + closing balances, we verify opening + Σamounts ≈ closing.
   * `reconciled === false` means the extracted transactions do NOT add up to the
   * statement's own ending balance — the numbers are suspect and MUST be reviewed
   * by a human before they feed a tax return. Never silently file unreconciled data.
   * `reconciled === null` means reconciliation could not be checked (e.g. the
   * statement didn't state balances, or it's multi-currency).
   */
  reconciliation?: {
    opening_balance: number | null
    closing_balance: number | null
    computed_closing: number | null
    reconciled: boolean | null
    note: string
  }
}

// ─── Categorization Rules ────────────────────────────────────

interface CategoryRule {
  pattern: RegExp
  category: CategorizedTransaction["category"]
  subcategory: string
}

// Generic rules — not client-specific. Specific vendor detection
// happens via related party matching against CRM contacts.
const CATEGORY_RULES: CategoryRule[] = [
  // INCOME — money received
  { pattern: /Ricevuto denaro da/i, category: "income", subcategory: "revenue" },
  { pattern: /Received money from/i, category: "income", subcategory: "revenue" },
  { pattern: /Complaint Compensation/i, category: "income", subcategory: "other_income" },

  // CONTRIBUTIONS — owner money in. NOT income: it belongs to the capital
  // account, never the P&L (F3 — counting a top-up as revenue overstates the return).
  { pattern: /Top Up via/i, category: "contribution", subcategory: "capital_contribution" },

  // DISTRIBUTIONS — money sent to members
  { pattern: /Dividends|dividend/i, category: "distribution", subcategory: "member_distribution" },

  // FEES — bank charges
  { pattern: /Wise Charges|FEE-/i, category: "fee", subcategory: "bank_fee" },
  { pattern: /Wire transfer fee/i, category: "fee", subcategory: "bank_fee" },
  { pattern: /Mercury fee/i, category: "fee", subcategory: "bank_fee" },

  // CONVERSIONS — currency exchanges (excluded from P&L)
  { pattern: /Convertit|Converted|BALANCE-/i, category: "conversion", subcategory: "currency_conversion" },

  // REFUNDS
  { pattern: /Refund|rimborso/i, category: "refund", subcategory: "refund" },

  // EXPENSES — catch-all for outgoing money not matched above
  { pattern: /prestazione lavorativa/i, category: "expense", subcategory: "freelancer" },
  { pattern: /Sent money to|Inviato denaro a/i, category: "expense", subcategory: "vendor_payment" },
]

/**
 * Categorize a transaction using rules + optional related party names
 */
export function categorizeTransaction(
  tx: ParsedTransaction,
  memberNames: string[] = [],
  relatedEntities: string[] = [],
): CategorizedTransaction {
  let category: CategorizedTransaction["category"] = "uncategorized"
  let subcategory = ""
  let is_related_party = false
  let notes = ""

  // Check rules in order — first match wins
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(tx.description)) {
      category = rule.category
      subcategory = rule.subcategory
      break
    }
  }

  // Override: if outgoing payment to a member → distribution
  if (tx.amount < 0 && memberNames.length > 0) {
    const lowerDesc = tx.description.toLowerCase()
    const lowerCounterparty = tx.counterparty.toLowerCase()
    for (const name of memberNames) {
      const lowerName = name.toLowerCase()
      if (lowerDesc.includes(lowerName) || lowerCounterparty.includes(lowerName)) {
        // Check if it's explicitly marked as distribution/dividends
        if (/dividend|distribu/i.test(tx.description)) {
          category = "distribution"
          subcategory = "member_distribution"
        }
        is_related_party = true
        notes = `Member: ${name}`
        break
      }
    }
  }

  // Check for related entities (e.g., Dubai FZCO owned by same members)
  if (relatedEntities.length > 0) {
    const lowerDesc = tx.description.toLowerCase()
    const lowerCounterparty = tx.counterparty.toLowerCase()
    for (const entity of relatedEntities) {
      const lowerEntity = entity.toLowerCase()
      if (lowerDesc.includes(lowerEntity) || lowerCounterparty.includes(lowerEntity)) {
        is_related_party = true
        notes = notes ? `${notes} | Related entity: ${entity}` : `Related entity: ${entity}`
        break
      }
    }
  }

  return {
    ...tx,
    category,
    subcategory,
    is_related_party,
    notes,
  }
}

// ─── CSV Parser (Primary) ───────────────────────────────────

/**
 * Parse an Italian number format: 1.499,00 → 1499.00
 */
function parseItalianNumber(str: string): number {
  if (!str || str.trim() === "") return 0
  // Remove thousand separators (dots), replace comma with dot
  const cleaned = str.trim().replace(/\./g, "").replace(",", ".")
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

/**
 * Parse a standard number format: 1,499.00 → 1499.00
 */
function parseStandardNumber(str: string): number {
  if (!str || str.trim() === "") return 0
  const cleaned = str.trim().replace(/,/g, "")
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

/**
 * Detect number format (Italian vs standard) from a sample
 */
function detectNumberFormat(values: string[]): "italian" | "standard" {
  for (const v of values) {
    if (!v || v.trim() === "") continue
    // Italian: 1.234,56 (dot for thousands, comma for decimals)
    if (/\d+\.\d{3},\d{2}/.test(v.trim())) return "italian"
    // Standard: 1,234.56 (comma for thousands, dot for decimals)
    if (/\d+,\d{3}\.\d{2}/.test(v.trim())) return "standard"
    // Simple comma decimal without thousands: 234,56
    if (/^\d+,\d{2}$/.test(v.trim())) return "italian"
  }
  return "standard"
}

/**
 * Parse a CSV string into rows, handling quoted fields
 */
function parseCSVRows(csv: string): string[][] {
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
          i++ // skip next quote
        } else if (ch === '"') {
          inQuote = false
        } else {
          currentField += ch
        }
      } else {
        if (ch === '"') {
          inQuote = true
        } else if (ch === ",") {
          currentRow.push(currentField)
          currentField = ""
        } else {
          currentField += ch
        }
      }
    }
    if (inQuote) {
      // Field continues on next line
      currentField += "\n"
    } else {
      currentRow.push(currentField)
      currentField = ""
      if (currentRow.some(f => f.trim() !== "")) {
        rows.push(currentRow)
      }
      currentRow = []
    }
  }
  // Handle last row
  if (currentRow.length > 0 || currentField) {
    currentRow.push(currentField)
    if (currentRow.some(f => f.trim() !== "")) {
      rows.push(currentRow)
    }
  }

  return rows
}

/**
 * Parse Wise CSV export.
 * Wise CSV columns vary by language but typically include:
 * TransferWise ID, Date, Amount, Currency, Description, Payment Reference,
 * Running Balance, Exchange From Amount, etc.
 */
export function parseWiseCSV(csvContent: string, fileName: string): ParseResult {
  const errors: string[] = []
  const transactions: ParsedTransaction[] = []

  const rows = parseCSVRows(csvContent)
  if (rows.length < 2) {
    return { transactions: [], bank_name: "Wise", currency: "EUR", account_holder: "", period: "", errors: ["Empty CSV"] }
  }

  // Find header row
  const header = rows[0].map(h => h.trim().toLowerCase())

  // Map column indices (handle both English and Italian headers)
  const colMap: Record<string, number> = {}
  const headerMappings: Record<string, string[]> = {
    id: ["transferwise id", "wise id", "id"],
    date: ["date", "data"],
    amount: ["amount", "importo"],
    currency: ["currency", "valuta"],
    description: ["description", "descrizione"],
    reference: ["payment reference", "riferimento pagamento", "reference"],
    balance: ["running balance", "saldo corrente", "balance"],
    merchant: ["merchant", "esercente"],
    note: ["note", "nota"],
  }

  for (const [key, variants] of Object.entries(headerMappings)) {
    for (const variant of variants) {
      const idx = header.indexOf(variant)
      if (idx !== -1) {
        colMap[key] = idx
        break
      }
    }
  }

  if (colMap.date === undefined || colMap.amount === undefined) {
    return { transactions: [], bank_name: "Wise", currency: "EUR", account_holder: "", period: "", errors: ["Could not find required columns (date, amount)"] }
  }

  // Detect number format from amount column
  const amountSamples = rows.slice(1, 10).map(r => r[colMap.amount] || "")
  const numFormat = detectNumberFormat(amountSamples)
  const parseNum = numFormat === "italian" ? parseItalianNumber : parseStandardNumber

  // Detect currency from filename or data
  let currency = "EUR"
  if (/usd/i.test(fileName)) currency = "USD"
  else if (/gbp/i.test(fileName)) currency = "GBP"
  else if (colMap.currency !== undefined) {
    const firstCurrency = rows[1]?.[colMap.currency]?.trim()
    if (firstCurrency) currency = firstCurrency.toUpperCase()
  }

  // Parse data rows
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 3) continue

    try {
      const dateStr = row[colMap.date]?.trim() || ""
      const amount = parseNum(row[colMap.amount] || "0")
      const description = row[colMap.description]?.trim() || ""
      const paymentRef = row[colMap.reference]?.trim() || ""
      const reference = paymentRef || row[colMap.id]?.trim() || ""
      const balance = colMap.balance !== undefined ? parseNum(row[colMap.balance] || "") : null

      // Fold the client's own note into the matched text (2026-07-02, B&P
      // golden repro): Wise "Sent money to X" rows do NOT embed the Payment
      // Reference in the description (received rows do), so notes like
      // "Dividend" / "Invoice 45" were invisible to every rule and the AI —
      // €29k of B&P owner dividends were booked as expenses. Dedup-safe: the
      // transaction_ref comes from the reference itself when present, and the
      // no-reference hash below uses the ORIGINAL description.
      const descriptionWithRef =
        paymentRef && !description.toLowerCase().includes(paymentRef.toLowerCase())
          ? `${description} with reference ${paymentRef}`
          : description

      // Parse date (Wise uses DD-MM-YYYY or YYYY-MM-DD or DD/MM/YYYY)
      let isoDate = ""
      const dmy = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/)
      const ymd = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
      if (dmy) {
        isoDate = `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`
      } else if (ymd) {
        isoDate = `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`
      } else {
        errors.push(`Row ${i + 1}: could not parse date "${dateStr}"`)
        continue
      }

      // Extract counterparty from description
      let counterparty = ""
      const fromMatch = description.match(/(?:Ricevuto denaro da|Received money from)\s+(.+?)(?:\s+con causale|\s+with reference|$)/i)
      const toMatch = description.match(/(?:Inviato denaro a|Sent money to)\s+(.+?)(?:\s+con causale|\s+with reference|$)/i)
      if (fromMatch) counterparty = fromMatch[1].trim()
      else if (toMatch) counterparty = toMatch[1].trim()

      if (amount === 0) continue // Skip zero transactions

      transactions.push({
        transaction_date: isoDate,
        description: descriptionWithRef,
        counterparty,
        amount,
        currency,
        balance_after: balance === 0 && colMap.balance === undefined ? null : balance,
        // refs are the dedup identity and must never be blank (DB CHECK since
        // 20260611-1400) — rows without a Wise reference get a content hash.
        // The hash uses the ORIGINAL description (not descriptionWithRef) so
        // the reference-folding above can never change a row's identity.
        transaction_ref: reference && reference.trim() !== ""
          ? reference
          : stableRowRef([isoDate, amount, description, balance]),
        bank_name: "Wise",
        account_type: currency,
      })
    } catch (err: any) {
      errors.push(`Row ${i + 1}: ${err.message}`)
    }
  }

  // Determine period from transaction dates
  const dates = transactions.map(t => t.transaction_date).sort()
  const period = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : "unknown"

  return {
    transactions,
    bank_name: "Wise",
    currency,
    account_holder: "",
    period,
    errors,
  }
}

// ─── PDF Parser (Fallback) ──────────────────────────────────

/**
 * Split two concatenated Italian-format numbers on a single line.
 * pdf-parse extracts Wise PDF tables with amounts concatenated, e.g.:
 *   "999,005.037,81"  → [999.00, 5037.81]    (incoming: amount, balance)
 *   "-3.531,000,07"   → [-3531.00, 0.07]     (outgoing: -amount, balance)
 *   "-5,555.032,26"   → [-5.55, 5032.26]     (fee: -amount, balance)
 *   "82,531.676,53"   → [82.53, 1676.53]     (conversion credit)
 *
 * Italian numbers always end with ,DD (comma + 2 decimal digits).
 * Strategy: find the first ,DD boundary that splits into two valid numbers.
 */
function splitConcatenatedAmounts(raw: string): { amount: number; balance: number } | null {
  const s = raw.trim()
  if (!s) return null

  // Try splitting at each ,DD position
  // Italian number: optional minus, digits (with optional . thousand separators), comma, 2 digits
  const re = /,\d{2}/g
  let match: RegExpExecArray | null
  const positions: number[] = []
  while ((match = re.exec(s)) !== null) {
    positions.push(match.index + 3) // position after ,DD
  }

  // Try each split point — first valid split wins
  for (const pos of positions) {
    if (pos >= s.length) continue // ,DD is at the very end — that would leave no balance
    const left = s.substring(0, pos)
    const right = s.substring(pos)

    // Both parts must be valid Italian numbers
    const leftNum = parseItalianNumber(left)
    const rightNum = parseItalianNumber(right)

    // Validate: right part should look like an Italian number (starts with digit or minus)
    if (/^-?[\d.]/.test(right) && (leftNum !== 0 || /^-?0,00$/.test(left.trim()))) {
      return { amount: leftNum, balance: rightNum }
    }
  }

  // Fallback: if only one ,DD found, the whole thing might be a single number
  if (positions.length === 1) {
    return { amount: parseItalianNumber(s), balance: 0 }
  }

  return null
}

/**
 * Parse Wise PDF statement (Italian language).
 * Uses pdf-parse to extract text, then regex to find transactions.
 *
 * Actual PDF text format (after pdf-parse extraction):
 *   Line 1: Description (possibly multi-line, e.g. "Ricevuto denaro da NAME con causale ...")
 *   Line 2: "DD mmmm YYYYTransazione: REFCausale: ..."  (date glued to "Transazione")
 *   Line 3: "AMOUNT_BALANCE"  (two Italian numbers concatenated, e.g. "999,005.037,81")
 */
export async function parseWisePDF(pdfBuffer: Buffer, fileName: string): Promise<ParseResult> {
  const errors: string[] = []
  const transactions: ParsedTransaction[] = []

  // Dynamic import pdf-parse v1 (CommonJS module)
  // Import from lib/pdf-parse.js directly to avoid the test-file loading in index.js
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (buf: Buffer) => Promise<{ text: string; numpages: number }>
  const data = await pdfParse(pdfBuffer)
  const text = data.text

  // Detect currency from filename or content
  let currency = "EUR"
  if (/usd/i.test(fileName)) currency = "USD"
  else if (/gbp/i.test(fileName)) currency = "GBP"
  else if (/Estratto conto in USD/i.test(text)) currency = "USD"
  else if (/Estratto conto in GBP/i.test(text)) currency = "GBP"

  // Extract account holder — "Titolare del conto" followed by company name on next line
  let accountHolder = ""
  const holderIdx = text.indexOf("Titolare del conto")
  if (holderIdx !== -1) {
    const afterHolder = text.substring(holderIdx + "Titolare del conto".length).trim()
    const firstLine = afterHolder.split("\n")[0]?.trim()
    if (firstLine && !/^\d/.test(firstLine)) {
      accountHolder = firstLine
    }
  }

  // Parse using the actual Wise PDF format:
  // 1. Description lines (Ricevuto/Inviato/Wise Charges/Convertit...)
  // 2. Date+Ref line: "DD mmmm YYYYTransazione: REF..."
  // 3. Amounts line: concatenated Italian numbers
  const lines = text.split("\n").map(l => l.trim())

  // Regex to detect date+transaction lines (date glued to "Transazione")
  const dateTransRe = /^(\d{1,2}\s+\w+\s+\d{4})Transazione:\s*(.+)$/i

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Look for date+transaction reference lines
    const dateMatch = line.match(dateTransRe)
    if (!dateMatch) continue

    const isoDate = parseItalianDate(dateMatch[1].trim())
    if (!isoDate) continue

    // Extract transaction ref and causale from the date line
    // Format: "TRANSFER-1234567Causale: some text" or just "TRANSFER-1234567"
    let ref = dateMatch[2].trim()
    let causale = ""
    const causaleIdx = ref.indexOf("Causale:")
    if (causaleIdx !== -1) {
      causale = ref.substring(causaleIdx + "Causale:".length).trim()
      ref = ref.substring(0, causaleIdx).trim()
    }

    // Collect description from lines ABOVE this date line
    // Walk backwards to find the description start
    const descLines: string[] = []
    for (let j = i - 1; j >= 0; j--) {
      const prevLine = lines[j]
      // Stop at: empty lines, page markers, header lines, previous amount lines, footer lines
      if (!prevLine) break
      if (/^ref:[0-9a-f-]+$/i.test(prevLine)) break
      if (/^\d+\s*\/\s*\d+$/.test(prevLine)) break // page number like "1 / 2"
      if (/^(Wise US Inc|Estratto conto|Generato il|Titolare del conto|IBAN|Swift\/BIC|Saldo in|Descrizione|Per qualsiasi|Hai bisogno)/i.test(prevLine)) break
      if (/^(BE\d{2}\s|TRWI|CMFG|United States|Sheridan|30 North Gould|30 W 26th|New York|Numero di conto|Wire routing|Routing number)/i.test(prevLine)) break
      if (/^(WY|NY|\d{5})$/.test(prevLine)) break // standalone state/zip codes
      // If this line looks like a previous amounts line (only digits, dots, commas, minus)
      if (/^-?[\d.,]+$/.test(prevLine)) break
      descLines.unshift(prevLine)
      // Stop if we found the start of a transaction description
      if (/^(Ricevuto denaro|Inviato denaro|Wise Charges|Convertit|Complaint|Top Up)/i.test(prevLine)) break
    }

    // Build description: lines from PDF + causale from date line
    let description = descLines.join(" ").trim()
    if (!description) continue
    // Append causale if not already present in description (for categorization)
    if (causale && !description.toLowerCase().includes(causale.toLowerCase().substring(0, 20))) {
      description = `${description} — ${causale}`
    }

    // Get amounts from the next line
    const amountLine = lines[i + 1] || ""
    if (!/^-?[\d.,]+$/.test(amountLine)) {
      errors.push(`Line ${i + 2}: expected amounts, got "${amountLine.substring(0, 40)}"`)
      continue
    }

    const amounts = splitConcatenatedAmounts(amountLine)
    if (!amounts) {
      errors.push(`Line ${i + 2}: could not parse amounts "${amountLine}"`)
      continue
    }

    i++ // skip the amounts line

    // Determine amount sign based on description type
    let amount = amounts.amount
    const balance = amounts.balance

    // For "Inviato" (sent) and "Wise Charges" the amount should be negative
    if (/^(Inviato denaro|Wise Charges|Convertit.*\bin\b)/i.test(description)) {
      // Amount from PDF might already be negative (has minus sign)
      if (amount > 0) amount = -amount
    }
    // For "Ricevuto" (received) and conversions TO this currency, amount should be positive
    if (/^(Ricevuto denaro|Convertit.*\bda\b.*\ba\s)/i.test(description)) {
      if (amount < 0) amount = -amount
    }

    // Extract counterparty
    let counterparty = ""
    const fromMatch = description.match(/Ricevuto denaro da\s+(.+?)(?:\s+con causale|$)/i)
    const toMatch = description.match(/Inviato denaro a\s+(.+?)(?:\s+con causale|$)/i)
    if (fromMatch) counterparty = fromMatch[1].trim()
    else if (toMatch) counterparty = toMatch[1].trim()
    else if (/^Wise Charges/i.test(description)) counterparty = "Wise"

    if (amount === 0) continue

    transactions.push({
      transaction_date: isoDate,
      description,
      counterparty,
      amount,
      currency,
      balance_after: balance,
      transaction_ref: ref,
      bank_name: "Wise",
      account_type: currency,
    })
  }

  const dates = transactions.map(t => t.transaction_date).filter(d => d).sort()
  const period = dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : "unknown"

  return {
    transactions,
    bank_name: "Wise",
    currency,
    account_holder: accountHolder,
    period,
    errors,
  }
}

// ─── Italian Date Parsing ───────────────────────────────────

const ITALIAN_MONTHS: Record<string, string> = {
  gennaio: "01", febbraio: "02", marzo: "03", aprile: "04",
  maggio: "05", giugno: "06", luglio: "07", agosto: "08",
  settembre: "09", ottobre: "10", novembre: "11", dicembre: "12",
  gen: "01", feb: "02", mar: "03", apr: "04",
  mag: "05", giu: "06", lug: "07", ago: "08",
  set: "09", ott: "10", nov: "11", dic: "12",
}

function parseItalianDate(dateStr: string): string {
  // "15 gennaio 2025" → "2025-01-15"
  const match = dateStr.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/)
  if (match) {
    const day = match[1].padStart(2, "0")
    const monthStr = match[2].toLowerCase()
    const month = ITALIAN_MONTHS[monthStr]
    const year = match[3]
    if (month) return `${year}-${month}-${day}`
  }

  // "15-01-2025" or "15/01/2025"
  const dmy = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`

  // "2025-01-15"
  const ymd = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, "0")}-${ymd[3].padStart(2, "0")}`

  return ""
}

// ─── Auto-detect and Parse ──────────────────────────────────

/**
 * Auto-detect file type and parse accordingly.
 * CSV = primary, PDF = fallback.
 */
export interface ParseOptions {
  /** Injected fetch (tests only). */
  fetchImpl?: typeof fetch
  /** Override the AI model (tests / tuning). */
  aiModel?: string
  /** Tax year being processed — the year anchor for exports whose dates
   *  carry no year (Slash: "Dec 30"). */
  taxYear?: number
}

const aiDisabled = () => process.env.BANK_STATEMENT_AI_DISABLED === "true"

function unsupportedResult(fileName: string, mimeType: string): ParseResult {
  return {
    transactions: [],
    bank_name: "unknown",
    currency: "USD",
    account_holder: "",
    period: "",
    errors: [`Unsupported file type: ${mimeType} (${fileName})`],
    extraction_method: "unknown",
  }
}

/**
 * Unpack a .zip archive (e.g. a year of monthly statements) and parse every
 * PDF/CSV inside, merging the transactions. Reconciliation is aggregated: the
 * archive fails reconciliation if ANY inner statement fails.
 */
async function parseZipArchive(zipBuffer: Buffer, zipName: string, opts?: ParseOptions): Promise<ParseResult> {
  const merged: ParseResult = {
    transactions: [], bank_name: "unknown", currency: "USD",
    account_holder: "", period: "", errors: [], extraction_method: "ai",
  }

  let entries: Record<string, Uint8Array>
  try {
    const { unzipSync } = await import("fflate")
    entries = unzipSync(new Uint8Array(zipBuffer))
  } catch (e) {
    merged.errors.push(`${zipName}: failed to unzip — ${e instanceof Error ? e.message : String(e)}`)
    return merged
  }

  const innerReconciliations: Array<boolean | null> = []
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || name.includes("__MACOSX/")) continue
    const lower = name.toLowerCase()
    const isPdf = lower.endsWith(".pdf")
    const isCsv = lower.endsWith(".csv")
    if (!isPdf && !isCsv) continue

    const innerName = name.split("/").pop() || name
    const r = await parseBankStatement(Buffer.from(bytes), innerName, isPdf ? "application/pdf" : "text/csv", opts)
    merged.transactions.push(...r.transactions)
    if (r.bank_name && r.bank_name !== "unknown") merged.bank_name = r.bank_name
    if (r.errors.length) merged.errors.push(...r.errors.map(e => `${innerName}: ${e}`))
    if (r.reconciliation) innerReconciliations.push(r.reconciliation.reconciled)
  }

  if (merged.transactions.length === 0 && merged.errors.length === 0) {
    merged.errors.push(`${zipName}: no PDF/CSV statements found inside archive`)
  }

  const anyFalse = innerReconciliations.some(v => v === false)
  const anyNull = innerReconciliations.some(v => v === null)
  merged.reconciliation = {
    opening_balance: null, closing_balance: null, computed_closing: null,
    reconciled: anyFalse ? false : anyNull ? null : innerReconciliations.length ? true : null,
    note: `Archive of ${innerReconciliations.length} statement(s): ${anyFalse ? "one or more did NOT reconcile — review" : anyNull ? "some could not be reconciled" : innerReconciliations.length ? "all reconciled" : "no statements parsed"}`,
  }
  return merged
}

/** One statement file extracted from a .zip archive. */
export interface ZipStatementEntry {
  /** Inner file name (basename, no folder path). */
  name: string
  bytes: Uint8Array
  /** "application/pdf" | "text/csv" */
  mime: string
}

/**
 * Expand a .zip and return each inner PDF/CSV statement (basename + bytes),
 * skipping directories, __MACOSX junk, and non-statement files. Same filter as
 * parseZipArchive — but it returns the raw entries instead of parsing inline, so
 * a caller can ingest each statement as its OWN background job (a big year-of-
 * statements zip otherwise exceeds one job's time budget). Throws on a corrupt
 * archive.
 */
export async function extractZipStatements(zipBuffer: Buffer): Promise<ZipStatementEntry[]> {
  const { unzipSync } = await import("fflate")
  const entries = unzipSync(new Uint8Array(zipBuffer))
  const out: ZipStatementEntry[] = []
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/") || name.includes("__MACOSX/")) continue
    const lower = name.toLowerCase()
    const isPdf = lower.endsWith(".pdf")
    const isCsv = lower.endsWith(".csv")
    if (!isPdf && !isCsv) continue
    out.push({ name: name.split("/").pop() || name, bytes, mime: isPdf ? "application/pdf" : "text/csv" })
  }
  return out
}

export async function parseBankStatement(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  opts?: ParseOptions,
): Promise<ParseResult> {
  const lowerName = fileName.toLowerCase()

  // ZIP archive — unpack + parse each inner statement, merge.
  if (mimeType === "application/zip" || mimeType === "application/x-zip-compressed" || lowerName.endsWith(".zip")) {
    return parseZipArchive(fileBuffer, fileName, opts)
  }

  const isCsv = mimeType === "text/csv" || lowerName.endsWith(".csv")
  const isPdf = mimeType === "application/pdf" || lowerName.endsWith(".pdf")

  // Fast path: hand-coded CSV parsers, routed by CONTENT SIGNATURE (header
  // row) — never by filename or the client's typed bank label (master plan
  // §2.5; clients mislabel). Known signatures parse deterministically (exact,
  // instant, free); unknown layouts fall to AI extraction below.
  if (isCsv) {
    const content = fileBuffer.toString("utf-8")
    const dialect = sniffCsvDialect(content)
    const headerCells = parseDelimitedRows(content, dialect.delimiter)[0] ?? []
    const signature = detectCsvSignature(headerCells)
    if (signature === "relay") {
      const r = parseRelayCSV(content, fileName)
      r.extraction_method = "relay_csv"
      if (r.transactions.length > 0) return r
    }
    if (signature === "mercury") {
      const r = parseMercuryCSV(content, fileName)
      r.extraction_method = "mercury_csv"
      if (r.transactions.length > 0) return r
    }
    if (signature === "revolut") {
      const r = parseRevolutCSV(content, fileName)
      r.extraction_method = "revolut_csv"
      if (r.transactions.length > 0) return r
    }
    if (signature === "slash") {
      const r = parseSlashCSV(content, fileName, { fallbackYear: opts?.taxYear })
      r.extraction_method = "slash_csv"
      if (r.transactions.length > 0) return r
    }
    if (signature === "wise" || /wise/i.test(lowerName) || /transferwise|wise\.com/i.test(content)) {
      const r = parseWiseCSV(content, fileName)
      r.extraction_method = "wise_csv"
      if (r.transactions.length > 0) return r
    }
    // Bank-agnostic generic CSV parser — ANY bank whose CSV has a recognizable
    // date + amount (or debit/credit) column parses here: free, instant, no AI,
    // and a brand-new bank "just works" with no per-bank code. ONLY for unknown
    // layouts (signature === null) — a recognized-but-not-deterministically-
    // parsed format like wise_transfers (source/target double-count semantics)
    // must still go to AI below, never the generic parser. Unmappable → AI too.
    if (signature === null) {
      const generic = parseGenericCSV(content, { fallbackYear: opts?.taxYear })
      if (generic.transactions.length > 0) { generic.extraction_method = "generic_csv"; return generic }
    }
  } else if (isPdf && /wise/i.test(lowerName)) {
    const r = await parseWisePDF(fileBuffer, fileName)
    r.extraction_method = "wise_pdf"
    if (r.transactions.length > 0) return r
  }

  // Everything else (Mercury/Relay/Chase/unknown bank) OR a Wise parse that found
  // 0 rows → bank-agnostic AI extraction with reconciliation guard.
  if (isCsv || isPdf) {
    if (aiDisabled()) {
      return {
        transactions: [], bank_name: "unknown", currency: "USD", account_holder: "", period: "",
        errors: [`No transactions parsed and AI extraction disabled (BANK_STATEMENT_AI_DISABLED) for ${fileName}`],
        extraction_method: "unknown",
      }
    }
    const { aiExtractBankStatement } = await import("./bank-statement-ai-extract")
    return aiExtractBankStatement(fileBuffer, fileName, mimeType, { fetchImpl: opts?.fetchImpl, model: opts?.aiModel })
  }

  return unsupportedResult(fileName, mimeType)
}
