/**
 * GET /api/tools/pnl/[id]/download — the workspace Excel (P&L + Balance Sheet +
 * K-1 capital + detail sheets), STAFF ONLY. Rendered from the SAME workspace
 * draft the on-screen review uses (getWorkspaceFinancialsView → buildFinancialsWorkbook),
 * so the file always matches the screen.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  try {
    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('tax_year, company_name')
      .eq('id', params.id)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })
    const taxYear = Number(ws.tax_year)
    const companyName = ws.company_name || 'Company'

    const { getWorkspaceFinancialsView } = await import('@/lib/tax/workspace-orchestration')
    const view = await getWorkspaceFinancialsView(params.id)
    if (view.transactionCount === 0) {
      return NextResponse.json({ error: 'No transactions yet — upload the statements first.' }, { status: 422 })
    }

    const txRows = await fetchAllPaged<{
      transaction_date: string; description: string | null; counterparty: string | null
      amount: number; currency: string | null; category: string | null; subcategory: string | null
      bank_name: string | null; account_type: string | null; is_related_party: boolean | null; transaction_ref: string | null
    }>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, is_related_party, transaction_ref')
        .eq('workspace_id', params.id)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return data ?? []
    })

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
    console.error('[tools/pnl] download failed:', err)
    return NextResponse.json({ error: 'Could not generate the file — please try again.' }, { status: 500 })
  }
}
