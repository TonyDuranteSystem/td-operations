/**
 * POST /api/portal/tax-financials/set-bucket
 *   { account_id, tax_year, transaction_ids, bucket }
 *
 * Client moves a merchant group into an expense bucket on the review screen
 * (#2). This sets the ADVISORY `ai_bucket` on the group's rows — it only changes
 * how the review is grouped, never the bookkeeping category or the P&L. `bucket`
 * must be a live slug from the expense_categories catalog (or '' to clear).
 *
 * OWNER-ONLY; refused after confirm (post-confirm lock), like the answer route.
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
    const taxYear = Number(body.tax_year)
    const transactionIds = Array.isArray(body.transaction_ids) ? body.transaction_ids.map(String) : []
    const bucket = String(body.bucket ?? '').trim()

    if (!accountId || !Number.isInteger(taxYear) || transactionIds.length === 0) {
      return NextResponse.json({ error: 'account_id, tax_year and transaction_ids required' }, { status: 400 })
    }
    if (transactionIds.length > 2000) {
      return NextResponse.json({ error: 'Too many transactions in one move.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Validate the bucket against the live catalog (empty string clears it).
    if (bucket) {
      const { getEntry } = await import('@/lib/catalog/framework')
      const entry = await getEntry('expense_categories', bucket)
      if (!entry || entry.status !== 'active') {
        return NextResponse.json({ error: 'Unknown category.' }, { status: 400 })
      }
    }

    // Post-confirm lock — same rule as the answer route.
    // ONE resolver for which row is the client's file (see resolve-submission.ts):
    // the newest with real data. The old "newest of ANY status" let an unfilled
    // pending/opened form outrank the real submission and unlock it.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
    if (!canEdit) {
      return NextResponse.json({ error: 'Your submission is locked — ask us to reopen it before changing it.' }, { status: 409 })
    }

    // ai_bucket is not yet in the generated DB types — loose client for the write.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: updated, error } = await db
      .from('bank_transactions')
      .update({ ai_bucket: bucket || null })
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .in('id', transactionIds)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ updated: (updated ?? []).length })
  } catch (err) {
    console.error('[tax-financials] set-bucket failed:', err)
    return NextResponse.json({ error: 'Could not move the category — please try again.' }, { status: 500 })
  }
}
