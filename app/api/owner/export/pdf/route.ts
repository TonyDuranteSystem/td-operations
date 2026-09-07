import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { getOwnerPnL, getBalanceSheet, getFilingSummary } from '@/lib/owner-finance'
import { buildProfitAndLossHtml, buildBalanceSheetHtml, renderHtmlToPdf } from '@/lib/owner-finance-pdf'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DOC_BUILDERS = {
  pnl: { build: buildProfitAndLossHtml, filename: (year: number) => `Tony Durante LLC - Profit and Loss ${year}.pdf` },
  'balance-sheet': { build: buildBalanceSheetHtml, filename: (year: number) => `Tony Durante LLC - Balance Sheet ${year}.pdf` },
} as const

/**
 * GET /api/owner/export/pdf?year=YYYY&doc=pnl|balance-sheet — one clean, printable financial
 * statement PDF, built live from the same numbers the on-screen tabs show. See
 * lib/owner-finance-pdf.ts for why the actual rendering step can't be proven from a
 * developer's own machine — this route IS the test.
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
  const doc = searchParams.get('doc')
  if (doc !== 'pnl' && doc !== 'balance-sheet') {
    return NextResponse.json({ error: 'doc must be "pnl" or "balance-sheet"' }, { status: 400 })
  }
  const docConfig = DOC_BUILDERS[doc]

  const [pnl, balanceSheet] = await Promise.all([getOwnerPnL(year), getBalanceSheet(year)])
  const filing = await getFilingSummary(year)

  const html = docConfig.build({ year, pnl, balanceSheet, filing, transactions: [], accounts: [] })

  let pdfBuffer: Buffer
  try {
    pdfBuffer = await renderHtmlToPdf(html)
  } catch (error) {
    // The rendering step could not be proven outside the real serverless environment before
    // shipping (see lib/owner-finance-pdf.ts) — surface the real cause instead of an opaque
    // 500, so a first failure here is diagnosable rather than a dead end.
    const message = error instanceof Error ? error.message : 'PDF rendering failed'
    return NextResponse.json({ error: `PDF rendering failed: ${message}` }, { status: 500 })
  }

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${docConfig.filename(year)}"`,
    },
  })
}
