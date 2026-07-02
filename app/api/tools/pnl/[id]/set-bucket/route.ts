/**
 * POST /api/tools/pnl/[id]/set-bucket  { transaction_ids, bucket }
 *
 * Move a merchant group into an expense bucket on the workspace review screen
 * (STAFF ONLY). Sets the ADVISORY `ai_bucket` on the group's rows — never the
 * bookkeeping category. Isolated to the workspace table; `bucket` must be a live
 * expense_categories slug (or '' to clear).
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  try {
    const body = await request.json().catch(() => ({}))
    const transactionIds = Array.isArray(body.transaction_ids) ? body.transaction_ids.map(String) : []
    const bucket = String(body.bucket ?? '').trim()
    if (transactionIds.length === 0) return NextResponse.json({ error: 'transaction_ids required' }, { status: 400 })
    if (transactionIds.length > 2000) return NextResponse.json({ error: 'Too many transactions in one move.' }, { status: 400 })

    if (bucket) {
      const { getEntry } = await import('@/lib/catalog/framework')
      const entry = await getEntry('expense_categories', bucket)
      if (!entry || entry.status !== 'active') return NextResponse.json({ error: 'Unknown category.' }, { status: 400 })
    }

    const { data: updated, error } = await db
      .from('pnl_workspace_transactions')
      .update({ ai_bucket: bucket || null })
      .eq('workspace_id', params.id)
      .in('id', transactionIds)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ updated: (updated ?? []).length })
  } catch (err) {
    console.error('[tools/pnl] set-bucket failed:', err)
    return NextResponse.json({ error: 'Could not move the category — please try again.' }, { status: 500 })
  }
}
