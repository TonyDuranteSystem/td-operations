/**
 * GET /api/portal/tax-financials/category-transactions?account_id=&tax_year=&bucket=
 *
 * Drill-down for one Operating-Expenses category on the portal P&L (Luca's
 * request, dev_task 1bee0ffe): returns the individual transactions that make up
 * a single category line, grouped by merchant, so the client can self-serve
 * "what's inside this $164K Other?" instead of calling us.
 *
 * Loaded ON DEMAND (one category at a time) so the main P&L page load is
 * unchanged. OWNER-ONLY — same gate as the financials view; tax financials are
 * non-delegable. The bucket-assignment + operating-expense rules are the SHARED
 * helpers from expense-buckets, so a category's drill-down total always matches
 * its P&L line.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/** Cap on transactions returned — a guardrail for very large buckets. The client
 *  shows the count, so a truncated list is labelled honestly rather than implied
 *  to be complete. */
const MAX_TX = 1000

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const taxYear = Number(url.searchParams.get('tax_year'))
    const bucket = (url.searchParams.get('bucket') ?? '').trim()
    if (!accountId || !Number.isInteger(taxYear) || !bucket) {
      return NextResponse.json({ error: 'account_id, tax_year and bucket are required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { getExpenseBuckets, isOperatingExpenseRow, bucketSlugForRow, OTHER_BUCKET_SLUG, OTHER_BUCKET_LABEL } =
      await import('@/lib/tax/expense-buckets')
    const { merchantRoot } = await import('@/lib/tax/question-groups')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // ai_bucket not yet in database.types.ts
    const buckets = await getExpenseBuckets(db)
    const validSlugs = new Set(buckets.map(b => b.slug))
    const label = bucket === OTHER_BUCKET_SLUG
      ? OTHER_BUCKET_LABEL
      : (buckets.find(b => b.slug === bucket)?.label ?? null)
    // Unknown bucket that isn't the synthetic "other" → nothing to show.
    if (label === null) {
      return NextResponse.json({ bucket, label: bucket, merchants: [], total: 0, total_count: 0, truncated: false })
    }

    // Candidate operating-expense rows. When the bucket is a real catalog slug we
    // narrow at the DB by ai_bucket; "other" can't be narrowed (it's the absence
    // of a recognized bucket), so we fetch the candidates and filter in code —
    // the same code path the P&L breakdown uses, so totals stay in lockstep.
    const rows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      let q = db
        .from('bank_transactions')
        .select('id, description, counterparty, amount, transaction_date, bank_name, category, ai_bucket')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .in('category', ['expense', 'fee', 'uncategorized'])
        .order('id', { ascending: true })
        .range(from, to)
      if (bucket !== OTHER_BUCKET_SLUG) q = q.eq('ai_bucket', bucket)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })

    // Group by merchant root (same grouping as the review section, for a
    // consistent feel). Each transaction's contribution is |amount|.
    interface Tx { id: string; date: string; description: string; amount: number }
    const groups = new Map<string, { merchant: string; count: number; total: number; transactions: Tx[] }>()
    let totalCount = 0
    let total = 0
    let pushed = 0 // global cap on transaction objects returned (counts stay exact)
    for (const r of rows) {
      const amt = Number(r.amount)
      if (!isOperatingExpenseRow(r.category as string | null, amt)) continue
      if (bucketSlugForRow(r.ai_bucket, validSlugs) !== bucket) continue
      const desc = String(r.description ?? '')
      const root = merchantRoot(desc || String(r.counterparty ?? '')) || '(no description)'
      const key = root.toLowerCase()
      const abs = Math.abs(amt)
      totalCount++
      total += abs
      let g = groups.get(key)
      if (!g) { g = { merchant: root, count: 0, total: 0, transactions: [] }; groups.set(key, g) }
      g.count++
      g.total += abs
      if (pushed < MAX_TX) {
        g.transactions.push({ id: String(r.id), date: String(r.transaction_date ?? ''), description: desc, amount: abs })
        pushed++
      }
    }

    const merchants = Array.from(groups.values())
      .map(g => ({
        ...g,
        transactions: g.transactions.sort((a, b) => b.amount - a.amount),
      }))
      .sort((a, b) => b.total - a.total)

    return NextResponse.json({
      bucket,
      label,
      merchants,
      total,
      total_count: totalCount,
      truncated: pushed < totalCount,
    })
  } catch (err) {
    console.error('[tax-financials/category-transactions] failed:', err)
    return NextResponse.json(
      { error: 'Could not load this category — please try again.' },
      { status: 500 },
    )
  }
}
