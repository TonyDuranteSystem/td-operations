import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { getOwnerPnL, getBalanceSheet, getFilingSummary, getOwnerTransactions, getAccountRegistry } from '@/lib/owner-finance'
import { buildOwnerFinancialsWorkbook } from '@/lib/owner-finance-export'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/owner/export?year=YYYY — the full-books workbook (Profit & Loss, Balance Sheet,
 * category summary, every transaction, the account registry) for one year, built live from
 * the same numbers the on-screen tabs show. Replaces running .books-scratch scripts by hand
 * — see lib/owner-finance-export.ts for why this can never disagree with the app itself.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()), 10)
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 })
  }

  const [pnl, balanceSheet, transactions, accounts] = await Promise.all([
    getOwnerPnL(year),
    getBalanceSheet(year),
    getOwnerTransactions(year),
    getAccountRegistry(),
  ])
  // Filing summary needs the full-year transactions + the P&L already computed above —
  // same inputs computeFilingSummary already takes on the Tax tab, so this figure can
  // never drift from what that tab shows for the same year.
  const filing = await getFilingSummary(year)

  const workbook = buildOwnerFinancialsWorkbook({ year, pnl, balanceSheet, filing, transactions, accounts })
  const buffer = await workbook.xlsx.writeBuffer()

  return new NextResponse(Buffer.from(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Tony Durante LLC - ${year} Financial Statements and Ledger.xlsx"`,
    },
  })
}
