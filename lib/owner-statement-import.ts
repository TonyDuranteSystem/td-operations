/**
 * ONE statement file → rows in the owner's own books.
 *
 * This is the whole import decision — refuse-or-accept the filename, parse,
 * stamp the account onto every row, drop out-of-year activity, insert — and it
 * lives here rather than inside the HTTP route so that the browser upload and
 * any command-line load run the SAME code. That is not tidiness: every money
 * bug this pipeline has had was a per-row decision (the account-scoped
 * transaction_ref, the year guard, the filename being authoritative over the
 * parser's guess). A second copy of those decisions is a second place to get
 * them wrong, and the two copies would disagree silently.
 *
 * The route keeps only what is genuinely HTTP: auth, multipart, status codes.
 */
import { parseBankStatement, type ParsedTransaction } from '@/lib/bank-statement-parser'
import { insertOwnerTransactionRows, type OwnerImportRow } from '@/lib/owner-transactions-import'
import { parseStatementFilename } from '@/lib/owner-statement-filename'

/**
 * Why the outcomes are flat optional fields rather than a discriminated union:
 * this project compiles with `strict: false`, where a union does not narrow on
 * `status`, so every read would need a non-null assertion anyway.
 *
 *  needs_rename — the filename does not say which account this is. REFUSED.
 *  quarantined  — the parser cannot read the format confidently.
 *  transient    — a retryable failure (an AI/OCR hiccup), not a bad file.
 *  parse_failed — the file could not be read at all.
 *  empty        — read fine, contained no transactions (or none in the year).
 *  imported     — rows landed.
 */
export type OwnerStatementImportStatus =
  | 'imported' | 'needs_rename' | 'quarantined' | 'transient' | 'parse_failed' | 'empty'

export interface OwnerStatementImportOutcome {
  status: OwnerStatementImportStatus
  file: string
  /** Human message — the rename instruction, the parse error, the reason nothing landed. */
  error?: string
  account?: string
  account_type?: string
  imported?: number
  parsed_count?: number
  skipped_out_of_year?: number
  skipped_same_source?: number
  skipped_already_booked?: number
  duplicate_samples?: string[]
  warnings?: string[]
}

export interface OwnerStatementImportInput {
  fileName: string
  buffer: Buffer
  /** Defaulted from the extension when the caller has none (a CLI read has no MIME type). */
  mimeType?: string
  /** Rows dated outside this year are SKIPPED, never written. Null imports every year present. */
  targetYear: number | null
}

export async function importOwnerStatement(
  input: OwnerStatementImportInput,
): Promise<OwnerStatementImportOutcome> {
  const { fileName, buffer, targetYear } = input

  // ── Account identity, from the filename ────────────────────────────────────
  // REFUSE rather than guess. The account TYPE decides the accounting (a card and
  // a loan are debts, not cash) and the NUMBER decides identity — three First
  // Citizens accounts pass the same $1,068.30 between them. Landing rows under a
  // guessed or blank account silently mis-states money, and it already did: an
  // "unknown" bank payment to Amex and the card's own record of it were merged as
  // duplicates because neither carried an account.
  const account = parseStatementFilename(fileName)
  if (!account.ok) {
    return {
      status: 'needs_rename',
      file: fileName,
      error: `${account.error?.problem} ${account.error?.suggestion}`,
    }
  }

  const mimeType = input.mimeType
    || (fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/csv')

  let parsed
  try {
    parsed = await parseBankStatement(buffer, fileName, mimeType)
  } catch (error) {
    return {
      status: 'parse_failed',
      file: fileName,
      error: error instanceof Error ? error.message : 'Parse failed',
    }
  }

  if (parsed.quarantine) {
    return {
      status: 'quarantined',
      file: fileName,
      error: `Needs a one-tap format confirmation before this can be imported: ${parsed.quarantine.ambiguities.join(' ')}`,
    }
  }

  if (parsed.transient_failure) {
    return {
      status: 'transient',
      file: fileName,
      error: parsed.errors[0] || 'Temporary failure — please retry this file.',
    }
  }

  if (parsed.transactions.length === 0) {
    return {
      status: 'empty',
      file: fileName,
      imported: 0,
      error: parsed.errors[0] || 'No transactions found in this file.',
    }
  }

  const allRows: OwnerImportRow[] = parsed.transactions.map((t: ParsedTransaction) => ({
    transaction_date: t.transaction_date,
    description: t.description,
    counterparty: t.counterparty || undefined,
    amount: t.amount,
    currency: t.currency || undefined,
    // The filename is AUTHORITATIVE for the account, not the parser's guess. The
    // parser labels almost everything "unknown" (only Relay is recognised), and
    // an account label is what Cash Position groups balances by.
    bank_name: account.value!.label,
    // checking / savings / credit_card / loan / processor — this drives the
    // accounting treatment, not just display. NOTE: the parser used to put the
    // CURRENCY here; currency has its own column and is unaffected.
    account_type: account.value!.accountType,
    // ACCOUNT-SCOPED IDENTITY. The parsers hash (date, amount, description,
    // balance) with NO notion of which account the row came from, so two
    // genuinely separate transactions in two different accounts can produce the
    // SAME ref — and the ref check runs before the content check, so the second
    // one is discarded as "already imported" and a real transaction is lost.
    // OBSERVED, not theoretical: Antonio opened First Citizens checking 5812 and
    // 5820 on the same day, each with a $100 "Customer Deposit" leaving a $100
    // balance. Identical hash; the 5820 deposit vanished and 93 of 94 rows landed.
    transaction_ref: `${account.value!.accountNumber}:${t.transaction_ref}`,
    // Carried so the Cash Position can be built from real statements — the parsers
    // always produced this and the import path used to drop it on the floor.
    balance_after: t.balance_after ?? null,
    // tax_year comes from the transaction's OWN date, not the file/upload
    // date or a single assumed year — a statement can span a year boundary.
    tax_year: Number(t.transaction_date.slice(0, 4)),
  }))

  const rows = targetYear === null ? allRows : allRows.filter(r => r.tax_year === targetYear)
  const outOfYear = allRows.length - rows.length

  if (rows.length === 0) {
    return {
      status: 'empty',
      file: fileName,
      imported: 0,
      parsed_count: parsed.transactions.length,
      skipped_out_of_year: outOfYear,
      error: outOfYear > 0
        ? `All ${outOfYear} transaction(s) in this file are outside ${targetYear}. Nothing was imported.`
        : 'No transactions found in this file.',
    }
  }

  const result = await insertOwnerTransactionRows(rows)
  return {
    status: 'imported',
    file: fileName,
    account: account.value!.label,
    account_type: account.value!.accountType,
    imported: result.imported,
    parsed_count: parsed.transactions.length,
    skipped_out_of_year: outOfYear,
    // Split, because the two mean very different things to the operator:
    // "you already uploaded this exact file" vs "this money is already in your
    // books under another source (the bank feed, or the same statement in a
    // different format)". The second is the one worth looking at.
    skipped_same_source: result.skipped_same_source,
    skipped_already_booked: result.skipped_already_booked,
    duplicate_samples: result.duplicate_samples.length > 0 ? result.duplicate_samples : undefined,
    warnings: parsed.errors.length > 0 ? parsed.errors : undefined,
  }
}
