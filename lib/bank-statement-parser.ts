/**
 * Bank Statement Parser
 * Parses CSV and PDF bank statements from Wise, Mercury, and Relay.
 * CSV-first approach (structured data), PDF as fallback (via pdf-parse).
 *
 * Supported formats:
 *   - Wise CSV (EUR/USD, Italian & English)
 *   - Wise PDF (Italian language, fallback)
 *   - Mercury CSV (future)
 *   - Relay CSV (future)
 */

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
  category: "income" | "cogs" | "expense" | "distribution" | "fee" | "conversion" | "refund" | "uncategorized"
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
  { pattern: /Top Up via/i, category: "income", subcategory: "capital_contribution" },

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
      const reference = row[colMap.reference]?.trim() || row[colMap.id]?.trim() || ""
      const balance = colMap.balance !== undefined ? parseNum(row[colMap.balance] || "") : null

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
        description,
        counterparty,
        amount,
        currency,
        balance_after: balance === 0 && colMap.balance === undefined ? null : balance,
        transaction_ref: reference,
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
 * Parse Wise PDF statement (Italian language).
 * Uses pdf-parse to extract text, then regex to find transactions.
 */
export async function parseWisePDF(pdfBuffer: Buffer, fileName: string): Promise<ParseResult> {
  const errors: string[] = []
  const transactions: ParsedTransaction[] = []

  // Dynamic import pdf-parse v1 (CommonJS module)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = (await import("pdf-parse")).default as (buf: Buffer) => Promise<{ text: string; numpages: number }>
  const data = await pdfParse(pdfBuffer)
  const text = data.text

  // Detect currency from filename or content
  let currency = "EUR"
  if (/usd/i.test(fileName)) currency = "USD"
  else if (/gbp/i.test(fileName)) currency = "GBP"
  else if (/Estratto conto in USD/i.test(text)) currency = "USD"
  else if (/Estratto conto in GBP/i.test(text)) currency = "GBP"

  // Extract account holder
  let accountHolder = ""
  const holderMatch = text.match(/Titolare del conto:\s*(.+?)(?:\n|$)/i)
    || text.match(/Account holder:\s*(.+?)(?:\n|$)/i)
  if (holderMatch) accountHolder = holderMatch[1].trim()

  // Parse Italian Wise PDF format
  // Pattern: "Ricevuto denaro da NAME con causale DESC    AMOUNT    BALANCE"
  // Followed by: "DATE Transazione: REF"
  const lines = text.split("\n").map(l => l.trim())

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Match incoming transactions: "Ricevuto denaro da ..."
    const incomingMatch = line.match(/^(Ricevuto denaro da .+?)\s+([\d.,]+)\s+([\d.,]+)\s*$/)
    if (incomingMatch) {
      const desc = incomingMatch[1].trim()
      const amount = parseItalianNumber(incomingMatch[2])
      const balance = parseItalianNumber(incomingMatch[3])

      // Next line should have date and reference
      const nextLine = lines[i + 1] || ""
      const dateRefMatch = nextLine.match(/^(\d{1,2}\s+\w+\s+\d{4})\s+Transazione:\s*(.+)$/i)
        || nextLine.match(/^(\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+Transazione:\s*(.+)$/i)

      let isoDate = ""
      let ref = ""
      if (dateRefMatch) {
        isoDate = parseItalianDate(dateRefMatch[1].trim())
        ref = dateRefMatch[2].trim()
        i++ // skip the date line
      }

      // Extract counterparty
      const cpMatch = desc.match(/Ricevuto denaro da\s+(.+?)(?:\s+con causale|$)/i)
      const counterparty = cpMatch ? cpMatch[1].trim() : ""

      if (isoDate && amount > 0) {
        transactions.push({
          transaction_date: isoDate,
          description: desc,
          counterparty,
          amount,
          currency,
          balance_after: balance,
          transaction_ref: ref,
          bank_name: "Wise",
          account_type: currency,
        })
      }
      continue
    }

    // Match outgoing transactions: "Inviato denaro a ..."
    const outgoingMatch = line.match(/^(Inviato denaro a .+?)\s+-?([\d.,]+)\s+([\d.,]+)\s*$/)
    if (outgoingMatch) {
      const desc = outgoingMatch[1].trim()
      const amount = -parseItalianNumber(outgoingMatch[2])
      const balance = parseItalianNumber(outgoingMatch[3])

      const nextLine = lines[i + 1] || ""
      const dateRefMatch = nextLine.match(/^(\d{1,2}\s+\w+\s+\d{4})\s+Transazione:\s*(.+)$/i)
        || nextLine.match(/^(\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+Transazione:\s*(.+)$/i)

      let isoDate = ""
      let ref = ""
      if (dateRefMatch) {
        isoDate = parseItalianDate(dateRefMatch[1].trim())
        ref = dateRefMatch[2].trim()
        i++
      }

      const cpMatch = desc.match(/Inviato denaro a\s+(.+?)(?:\s+con causale|$)/i)
      const counterparty = cpMatch ? cpMatch[1].trim() : ""

      if (isoDate) {
        transactions.push({
          transaction_date: isoDate,
          description: desc,
          counterparty,
          amount,
          currency,
          balance_after: balance,
          transaction_ref: ref,
          bank_name: "Wise",
          account_type: currency,
        })
      }
      continue
    }

    // Match fees: "Wise Charges for: REF    -AMOUNT    BALANCE"
    const feeMatch = line.match(/^(Wise Charges .+?)\s+-?([\d.,]+)\s+([\d.,]+)\s*$/)
    if (feeMatch) {
      const desc = feeMatch[1].trim()
      const amount = -parseItalianNumber(feeMatch[2])
      const balance = parseItalianNumber(feeMatch[3])

      const nextLine = lines[i + 1] || ""
      const dateRefMatch = nextLine.match(/^(\d{1,2}\s+\w+\s+\d{4})\s+Transazione:\s*(.+)$/i)
        || nextLine.match(/^(\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+Transazione:\s*(.+)$/i)

      let isoDate = ""
      let ref = ""
      if (dateRefMatch) {
        isoDate = parseItalianDate(dateRefMatch[1].trim())
        ref = dateRefMatch[2].trim()
        i++
      }

      if (isoDate) {
        transactions.push({
          transaction_date: isoDate,
          description: desc,
          counterparty: "Wise",
          amount,
          currency,
          balance_after: balance,
          transaction_ref: ref,
          bank_name: "Wise",
          account_type: currency,
        })
      }
      continue
    }

    // Match conversions: "Convertiti EUR in USD ..."
    const convMatch = line.match(/^(Convertit.+?)\s+-?([\d.,]+)\s+([\d.,]+)\s*$/)
    if (convMatch) {
      const desc = convMatch[1].trim()
      const amount = -parseItalianNumber(convMatch[2])
      const balance = parseItalianNumber(convMatch[3])

      const nextLine = lines[i + 1] || ""
      const dateRefMatch = nextLine.match(/^(\d{1,2}\s+\w+\s+\d{4})\s+Transazione:\s*(.+)$/i)
        || nextLine.match(/^(\d{1,2}[-/]\d{1,2}[-/]\d{4})\s+Transazione:\s*(.+)$/i)

      let isoDate = ""
      let ref = ""
      if (dateRefMatch) {
        isoDate = parseItalianDate(dateRefMatch[1].trim())
        ref = dateRefMatch[2].trim()
        i++
      }

      if (isoDate) {
        transactions.push({
          transaction_date: isoDate,
          description: desc,
          counterparty: "",
          amount,
          currency,
          balance_after: balance,
          transaction_ref: ref,
          bank_name: "Wise",
          account_type: currency,
        })
      }
      continue
    }
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
export async function parseBankStatement(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<ParseResult> {
  const lowerName = fileName.toLowerCase()

  // CSV files
  if (mimeType === "text/csv" || lowerName.endsWith(".csv")) {
    const content = fileBuffer.toString("utf-8")
    if (/wise/i.test(lowerName) || /transferwise/i.test(content)) {
      return parseWiseCSV(content, fileName)
    }
    // Future: Mercury, Relay CSV parsers
    // For now, try Wise parser as it's the most common
    return parseWiseCSV(content, fileName)
  }

  // PDF files
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    if (/wise/i.test(lowerName)) {
      return parseWisePDF(fileBuffer, fileName)
    }
    // Future: Mercury, Relay PDF parsers
    // Try Wise parser as default
    return parseWisePDF(fileBuffer, fileName)
  }

  return {
    transactions: [],
    bank_name: "unknown",
    currency: "USD",
    account_holder: "",
    period: "",
    errors: [`Unsupported file type: ${mimeType} (${fileName})`],
  }
}
