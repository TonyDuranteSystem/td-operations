import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { importOwnerStatement } from '@/lib/owner-statement-import'

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
 *
 * The import DECISIONS (which account, which year, how a row is identified)
 * live in lib/owner-statement-import.ts so the command-line loader runs exactly
 * the same code — see the note at the top of that file.
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

  // The year being loaded. Rows outside it are SKIPPED and reported, never
  // written: a loan export carrying 2026 activity previously leaked 17 rows into
  // a year that was explicitly off limits.
  const targetYearRaw = formData.get('tax_year')
  const targetYear = typeof targetYearRaw === 'string' && /^\d{4}$/.test(targetYearRaw)
    ? Number(targetYearRaw)
    : null

  let outcome
  try {
    outcome = await importOwnerStatement({
      fileName: file.name,
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type || undefined,
      targetYear,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed'
    return NextResponse.json({ file: file.name, error: message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { status, ...body } = outcome

  // A refused filename is the operator's to fix, so it must READ as a failure
  // (400) rather than a quiet success with a message. Quarantine/transient are
  // 200 — the file is fine, it just needs another pass.
  if (status === 'needs_rename') {
    return NextResponse.json({ ...body, needs_rename: true }, { status: 400 })
  }
  if (status === 'parse_failed') {
    return NextResponse.json(body, { status: 500 })
  }
  if (status === 'quarantined') {
    return NextResponse.json({ ...body, quarantined: true }, { status: 200 })
  }
  if (status === 'transient') {
    return NextResponse.json({ ...body, transient: true }, { status: 200 })
  }
  return NextResponse.json(body)
}
