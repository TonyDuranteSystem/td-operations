/**
 * POST /api/portal/tax-financials/add-bucket
 *   { account_id, name }
 *
 * Client adds a new expense bucket from the review screen (#2, Antonio: buckets
 * must be flexible — a client-added one is MEMORIZED and offered to everyone).
 * The bucket is a GLOBAL catalog_entry in 'expense_categories'; it is deduped by
 * normalized slug so "Gas"/"gas "/"GAS" collapse to one row. Returns the full
 * live bucket list so the UI can refresh.
 *
 * OWNER-ONLY (consistent with the other tax-financials routes). Adding a bucket
 * is harmless global vocabulary; staff can curate/merge later via /catalog.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const rawName = String(body.name ?? '')

    if (!accountId) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { slugifyBucket, getExpenseBuckets } = await import('@/lib/tax/expense-buckets')
    const slug = slugifyBucket(rawName)
    if (slug.length < 2) {
      return NextResponse.json({ error: 'Please type a longer category name.' }, { status: 400 })
    }

    const { getEntry, addEntry } = await import('@/lib/catalog/framework')
    const existing = await getEntry('expense_categories', slug)
    let created = false
    if (!existing) {
      await addEntry(
        'expense_categories',
        { slug, display_name: rawName.trim().slice(0, 60), metadata: { sort_order: 500, seeded: false } },
        'client added an expense bucket from the tax-financials review',
        { kind: 'ui', userId: user.id },
      )
      created = true
    }

    const buckets = await getExpenseBuckets(supabaseAdmin)
    return NextResponse.json({ slug, created, buckets })
  } catch (err) {
    console.error('[tax-financials] add-bucket failed:', err)
    return NextResponse.json({ error: 'Could not add the category — please try again.' }, { status: 500 })
  }
}
