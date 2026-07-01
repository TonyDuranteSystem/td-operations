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
import { supabaseAdmin } from '@/lib/supabase-admin'

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

    // The SAME draft the screen renders — one engine, one set of numbers.
    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)
    if (view.transactionCount === 0) {
      return NextResponse.json({ error: 'No transactions yet — upload the statements first.' }, { status: 422 })
    }

    // Detail-sheet rows + company name + IRS rates for the USD column.
    const { fetchAllBankTransactionsByYear } = await import('@/lib/bank-transactions-fetch')
    const txRows = await fetchAllBankTransactionsByYear<{
      transaction_date: string; description: string | null; counterparty: string | null
      amount: number; currency: string | null; category: string | null; subcategory: string | null
      bank_name: string | null; account_type: string | null; is_related_party: boolean | null; transaction_ref: string | null
    }>(
      accountId, taxYear,
      'transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, is_related_party, transaction_ref',
      { column: 'transaction_date', ascending: true },
    )

    const { data: account } = await supabaseAdmin.from('accounts').select('company_name').eq('id', accountId).single()
    const companyName = account?.company_name || 'Company'

    const { getIrsRate } = await import('@/lib/pnl-generator')
    const rates: Record<string, number> = {}
    for (const c of Array.from(new Set(txRows.map(t => t.currency ?? 'USD')))) rates[c] = await getIrsRate(c, taxYear)

    const { buildFinancialsWorkbook } = await import('@/lib/tax/financials-excel')
    const result = await buildFinancialsWorkbook({ companyName, taxYear, draft: view.draft, transactions: txRows, rates })

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
