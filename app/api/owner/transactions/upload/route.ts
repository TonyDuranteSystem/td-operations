import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { parseBankStatement, type ParsedTransaction } from '@/lib/bank-statement-parser'
import { insertOwnerTransactionRows } from '@/lib/owner-transactions-import'

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

  const rows = parsed.transactions.map((t: ParsedTransaction) => ({
    transaction_date: t.transaction_date,
    description: t.description,
    counterparty: t.counterparty || undefined,
    amount: t.amount,
    currency: t.currency || undefined,
    bank_name: t.bank_name || parsed.bank_name || undefined,
    account_type: t.account_type || undefined,
    transaction_ref: t.transaction_ref,
    // tax_year comes from the transaction's OWN date, not the file/upload
    // date or a single assumed year — a statement can span a year boundary.
    tax_year: Number(t.transaction_date.slice(0, 4)),
  }))

  try {
    const result = await insertOwnerTransactionRows(rows)
    return NextResponse.json({
      file: file.name,
      imported: result.imported,
      parsed_count: parsed.transactions.length,
      skipped_duplicates: parsed.transactions.length - result.imported,
      warnings: parsed.errors.length > 0 ? parsed.errors : undefined,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed'
    return NextResponse.json({ file: file.name, error: message }, { status: 500 })
  }
}
