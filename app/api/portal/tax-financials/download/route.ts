/**
 * GET /api/portal/tax-financials/download?account_id=&tax_year=
 *
 * The Excel (P&L + Balance Sheet + K-1 capital accounts + detail sheets).
 * Rendered FROM the same engine draft (`getFinancialsView` → `buildFinancialsWorkbook`)
 * that the on-screen review uses, so the file always matches what the client /
 * staff saw. (Previously it used `generatePnlExcel`, which re-derived from raw
 * transactions with different beginning balances + uncategorized handling — the
 * downloaded file could disagree with the screen.) Owner OR staff (isAccountOwner
 * passes non-client roles).
 */

import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const taxYear = Number(url.searchParams.get('tax_year'))
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // 2026-08-20 hard-stop plan: refuse the SAME numbers the on-screen
    // review hides when the underlying data has a structural problem — a
    // direct hit on this route otherwise bypasses the screen entirely. No
    // override for this specific case.
    const { buildFinancialsWorkbookForAccount, getAccountStructuralProblem } = await import('@/lib/tax/financials-orchestration')
    if (await getAccountStructuralProblem(accountId, taxYear)) {
      return NextResponse.json({ error: 'This year has an unresolved data problem (an unreadable statement, or a missing-months question) — the numbers are not final and cannot be downloaded yet. Fix that first.' }, { status: 422 })
    }

    // The SAME workbook the accountant hand-off archives — one engine, one
    // filing artifact (buildFinancialsWorkbookForAccount).
    const result = await buildFinancialsWorkbookForAccount(accountId, taxYear)
    if (!result) {
      return NextResponse.json({ error: 'No transactions yet — upload the statements first.' }, { status: 422 })
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${result.fileName.replace(/[^a-zA-Z0-9._ -]/g, '')}"`,
      },
    })
  } catch (err) {
    console.error('[tax-financials] download failed:', err)
    return NextResponse.json({ error: 'Could not generate the file — please try again.' }, { status: 500 })
  }
}
