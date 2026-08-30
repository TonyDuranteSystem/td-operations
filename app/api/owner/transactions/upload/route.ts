import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { parseBankStatement, type ParsedTransaction } from '@/lib/bank-statement-parser'
import { insertOwnerTransactionRows } from '@/lib/owner-transactions-import'
import { parseStatementFilename } from '@/lib/owner-statement-filename'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/owner/transactions/upload — one real bank/card statement file
 * (CSV or PDF) in, parsed via the SAME engine already proven on filed client
 * tax returns, landed as uncategorized rows in the owner's own books.
 *
 * ONE FILE PER REQUEST, deliberately — Antonio has ~20 statements to bring
 * in; batching them into one multipart body risks the platform's request-size
 * limit, and one-at-a-time gives real per-file success/failure feedback
 * instead of an all-or-nothing batch. The client loops and calls this once
 * per file.
 *
 * Nothing here is categorized — every row lands `category=uncategorized`,
 * matching this table's own rule (see docs/systems/td-books.md) and Antonio's
 * explicit instruction not to trust any prior categorization, including his
 * own tax preparer's, without independently rebuilding it from the real data.
 */
export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }

  // ── Account identity, from the filename ────────────────────────────────────
  // REFUSE rather than guess. The account TYPE decides the accounting (a card and
  // a loan are debts, not cash) and the NUMBER decides identity — three First
  // Citizens accounts pass the same $1,068.30 between them. Landing rows under a
  // guessed or blank account silently mis-states money, and it already did: an
  // "unknown" bank payment to Amex and the card's own record of it were merged as
  // duplicates because neither carried an account.
  const account = parseStatementFilename(file.name)
  if (!account.ok) {
    return NextResponse.json({
      file: file.name,
      needs_rename: true,
      error: `${account.error?.problem} ${account.error?.suggestion}`,
    }, { status: 400 })
  }

  // The year being loaded. Rows outside it are SKIPPED and reported, never
  // written: a loan export carrying 2026 activity previously leaked 17 rows into
  // a year that was explicitly off limits.
  const targetYearRaw = formData.get('tax_year')
  const targetYear = typeof targetYearRaw === 'string' && /^\d{4}$/.test(targetYearRaw)
    ? Number(targetYearRaw)
    : null

  const buffer = Buffer.from(await file.arrayBuffer())
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/csv')

  let parsed
  try {
    parsed = await parseBankStatement(buffer, file.name, mimeType)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Parse failed'
    return NextResponse.json({ file: file.name, error: message }, { status: 500 })
  }

  if (parsed.quarantine) {
    return NextResponse.json({
      file: file.name,
      quarantined: true,
      error: `Needs a one-tap format confirmation before this can be imported: ${parsed.quarantine.ambiguities.join(' ')}`,
    }, { status: 200 })
  }

  if (parsed.transient_failure) {
    return NextResponse.json({
      file: file.name,
      transient: true,
      error: parsed.errors[0] || 'Temporary failure — please retry this file.',
    }, { status: 200 })
  }

  if (parsed.transactions.length === 0) {
    return NextResponse.json({
      file: file.name,
      imported: 0,
      error: parsed.errors[0] || 'No transactions found in this file.',
    }, { status: 200 })
  }

  const allRows = parsed.transactions.map((t: ParsedTransaction) => ({
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
    // Prefixing with the account number makes identity per-account, which is what
    // it always should have been. (The content-level check already includes the
    // account, so this closes the one path that bypassed it.)
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
    return NextResponse.json({
      file: file.name,
      imported: 0,
      parsed_count: parsed.transactions.length,
      skipped_out_of_year: outOfYear,
      error: outOfYear > 0
        ? `All ${outOfYear} transaction(s) in this file are outside ${targetYear}. Nothing was imported.`
        : 'No transactions found in this file.',
    }, { status: 200 })
  }

  try {
    const result = await insertOwnerTransactionRows(rows)
    return NextResponse.json({
      file: file.name,
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
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed'
    return NextResponse.json({ file: file.name, error: message }, { status: 500 })
  }
}
