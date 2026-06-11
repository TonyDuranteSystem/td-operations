/**
 * GET /api/portal/tax-financials?account_id=&tax_year=
 *
 * The financials view for the portal review screen (Slice 7/8): P&L draft,
 * balance sheet, six gate results, ownership resolution, per-file sources.
 * Computed on demand from bank_transactions — never stored.
 *
 * OWNER-ONLY (lib/portal/owner-access) — tax financials are non-delegable.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

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

    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)

    // Pattern-grouped questions for what's still uncategorized (Slice 8 —
    // one answer covers every transaction from the same merchant; the 5b
    // benchmark showed the top 25 merchant groups cover most of the residual).
    const { groupUncategorized } = await import('@/lib/tax/question-groups')
    const { data: uncatRows } = await supabaseAdmin
      .from('bank_transactions')
      .select('id, description, counterparty, amount, transaction_date, bank_name')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('category', 'uncategorized')
    const questions = groupUncategorized((uncatRows ?? []).map(r => ({ ...r, amount: Number(r.amount) })))

    // Per-file sources for the delete/replace cards (§6).
    const { data: sources } = await supabaseAdmin
      .from('bank_transactions')
      .select('source_file_id, bank_name, transaction_date')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
    const bySource = new Map<string, { bank_name: string; count: number; from: string; to: string }>()
    for (const r of sources ?? []) {
      const key = r.source_file_id ?? 'unknown'
      const cur = bySource.get(key)
      if (!cur) bySource.set(key, { bank_name: r.bank_name, count: 1, from: r.transaction_date, to: r.transaction_date })
      else {
        cur.count++
        if (r.transaction_date < cur.from) cur.from = r.transaction_date
        if (r.transaction_date > cur.to) cur.to = r.transaction_date
      }
    }

    return NextResponse.json({
      ...view,
      questions,
      files: Array.from(bySource.entries()).map(([source_file_id, s]) => ({ source_file_id, ...s })),
    })
  } catch (err) {
    console.error('[tax-financials] view failed:', err)
    return NextResponse.json({ error: 'Could not load your financials — please try again.' }, { status: 500 })
  }
}
