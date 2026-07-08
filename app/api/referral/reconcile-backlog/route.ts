/**
 * Referral backlog reconciler (CRM referrals page → "Reconcile backlog").
 *
 *  POST /api/referral/reconcile-backlog   Body: { apply?: boolean }
 *    apply=false (default): DRY RUN — returns the per-row decision report.
 *    apply=true: executes — issues the clear credits (idempotent), cancels
 *    duplicates, closes their stale "Process referral commission" tasks.
 *    Ambiguous rows are only ever reported ("needs decision"), never guessed.
 *
 * Dashboard-only.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { reconcileReferralBacklog } from '@/lib/operations/referral-backlog'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const apply = body?.apply === true

  try {
    const report = await reconcileReferralBacklog({ apply }, supabaseAdmin)
    return NextResponse.json(report)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Reconcile failed.' }, { status: 500 })
  }
}
