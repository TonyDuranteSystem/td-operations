/**
 * External / ad-hoc P&L support — for the /tools/pnl "external" mode, where the
 * company is NOT a CRM account. Parses uploaded bank-statement CSVs entirely
 * IN MEMORY (deterministic parsers only — AI disabled, no network, no timeout
 * risk) and maps them into the `bank_transactions` ROW SHAPE that the shared
 * engine (buildPnlWorkbook) consumes — WITHOUT ever touching the database.
 *
 * The core safety property: nothing here writes to `bank_transactions` (or any
 * table). The mapped rows exist only in memory for the duration of the request.
 * `bank_transactions.account_id` has a FK to `accounts`, so an external company
 * (no account row) genuinely cannot be persisted here — by design.
 */

import { parseBankStatement, categorizeTransaction, type CategorizedTransaction } from "@/lib/bank-statement-parser"
import type { Database } from "@/lib/database.types"

type BankTxRow = Database["public"]["Tables"]["bank_transactions"]["Row"]

export interface ExternalCsvFile {
  fileName: string
  mimeType: string
  buffer: Buffer
}

export interface ExternalParseResult {
  /** Rows whose transaction_date year === taxYear, in bank_transactions shape. */
  transactions: BankTxRow[]
  /** Distinct currencies seen (so the caller can fetch the IRS rates it needs). */
  currencies: string[]
  /** Per-file parse errors / notes (empty file, unrecognized layout, etc.). */
  errors: string[]
  /** How many files yielded zero usable rows for this year. */
  emptyFiles: number
}

/** Map a categorized (in-memory) transaction into the DB row shape the engine
 *  reads. All DB-only columns are null/placeholder — this row is NEVER inserted. */
function toBankTxRow(c: CategorizedTransaction, taxYear: number): BankTxRow {
  return {
    id: crypto.randomUUID(),
    account_id: null,
    tax_year: taxYear,
    transaction_date: c.transaction_date,
    description: c.description,
    counterparty: c.counterparty,
    category: c.category,
    subcategory: c.subcategory,
    amount: c.amount,
    currency: c.currency,
    balance_after: c.balance_after,
    bank_name: c.bank_name,
    account_type: c.account_type,
    transaction_ref: c.transaction_ref,
    is_related_party: c.is_related_party,
    notes: c.notes,
    ai_bucket: null,
    ai_lean: null,
    created_at: null,
    source_file_id: null,
  }
}

/**
 * Parse + categorize a set of uploaded CSVs for ONE tax year, returning rows in
 * bank_transactions shape. Deterministic only (disableAi): an unrecognized CSV
 * yields an error, never an AI call. Rows dated outside `taxYear` are dropped
 * (same year-anchor guard as the CRM ingest in tax-form-setup.ts).
 */
export async function parseExternalStatements(
  files: ExternalCsvFile[],
  memberNames: string[],
  taxYear: number,
): Promise<ExternalParseResult> {
  const transactions: BankTxRow[] = []
  const errors: string[] = []
  const currencySet = new Set<string>()
  let emptyFiles = 0

  for (const file of files) {
    let parsed
    try {
      parsed = await parseBankStatement(file.buffer, file.fileName, file.mimeType, {
        taxYear,
        disableAi: true,
      })
    } catch (e) {
      errors.push(`${file.fileName}: ${e instanceof Error ? e.message : String(e)}`)
      emptyFiles++
      continue
    }

    if (parsed.errors.length > 0) errors.push(...parsed.errors.map(e => `${file.fileName}: ${e}`))

    let usedFromFile = 0
    for (const tx of parsed.transactions) {
      const txYear = parseInt(tx.transaction_date.substring(0, 4), 10)
      if (txYear !== taxYear) continue
      const cat = categorizeTransaction(tx, memberNames, [])
      transactions.push(toBankTxRow(cat, taxYear))
      currencySet.add(cat.currency)
      usedFromFile++
    }
    if (usedFromFile === 0) emptyFiles++
  }

  return { transactions, currencies: Array.from(currencySet), errors, emptyFiles }
}
