/**
 * GET /api/tools/pnl/[id]/category-transactions?bucket= — expense-category
 * drill-down for a workspace (STAFF ONLY). Mirrors the portal drill-down against
 * the ISOLATED workspace table, using the SAME expense-bucket helpers so a
 * category's drill-down total always matches its P&L line.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const MAX_TX = 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const bucket = (new URL(request.url).searchParams.get('bucket') ?? '').trim()
  if (!bucket) return NextResponse.json({ error: 'bucket is required' }, { status: 400 })

  try {
    const { getExpenseBuckets, isOperatingExpenseRow, bucketSlugForRow, OTHER_BUCKET_SLUG, OTHER_BUCKET_LABEL } =
      await import('@/lib/tax/expense-buckets')
    const { merchantRoot } = await import('@/lib/tax/question-groups')

    const buckets = await getExpenseBuckets(db)
    const validSlugs = new Set(buckets.map(b => b.slug))
    const label = bucket === OTHER_BUCKET_SLUG ? OTHER_BUCKET_LABEL : (buckets.find(b => b.slug === bucket)?.label ?? null)
    if (label === null) return NextResponse.json({ bucket, label: bucket, merchants: [], total: 0, total_count: 0, truncated: false })

    const rows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      let q = db
        .from('pnl_workspace_transactions')
        .select('id, description, counterparty, amount, transaction_date, bank_name, category, ai_bucket')
        .eq('workspace_id', params.id)
        .in('category', ['expense', 'fee', 'uncategorized'])
        .order('id', { ascending: true })
        .range(from, to)
      if (bucket !== OTHER_BUCKET_SLUG) q = q.eq('ai_bucket', bucket)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })

    interface Tx { id: string; date: string; description: string; amount: number }
    const groups = new Map<string, { merchant: string; count: number; total: number; transactions: Tx[] }>()
    let totalCount = 0, total = 0, pushed = 0
    for (const r of rows) {
      const amt = Number(r.amount)
      if (!isOperatingExpenseRow(r.category as string | null, amt)) continue
      if (bucketSlugForRow(r.ai_bucket, validSlugs) !== bucket) continue
      const desc = String(r.description ?? '')
      const root = merchantRoot(desc || String(r.counterparty ?? '')) || '(no description)'
      const key = root.toLowerCase()
      const abs = Math.abs(amt)
      totalCount++; total += abs
      let g = groups.get(key)
      if (!g) { g = { merchant: root, count: 0, total: 0, transactions: [] }; groups.set(key, g) }
      g.count++; g.total += abs
      if (pushed < MAX_TX) { g.transactions.push({ id: String(r.id), date: String(r.transaction_date ?? ''), description: desc, amount: abs }); pushed++ }
    }

    const merchants = Array.from(groups.values())
      .map(g => ({ ...g, transactions: g.transactions.sort((a, b) => b.amount - a.amount) }))
      .sort((a, b) => b.total - a.total)

    return NextResponse.json({ bucket, label, merchants, total, total_count: totalCount, truncated: pushed < totalCount })
  } catch (err) {
    console.error('[tools/pnl/category-transactions] failed:', err)
    return NextResponse.json({ error: 'Could not load this category — please try again.' }, { status: 500 })
  }
}
