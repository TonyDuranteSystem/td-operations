/**
 * POST /api/portal/tax-financials/period-answer-undo
 *   { account_id, tax_year, batch_id }
 *
 * Reverse one books location-answer batch (Phase B2) — exact per-row restore
 * from pnl_period_answer_book_rows; rows re-answered after the sweep are
 * skipped; a country batch's standing policy is deactivated. Clients may undo
 * their OWN batches only (a staff answer is not the client's to revert).
 *
 * OWNER-ONLY; refused after confirm (post-confirm lock); resets attestation.
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

    const body = await request.json().catch(() => ({})) as { account_id?: string; tax_year?: number; batch_id?: string }
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    const batchId = String(body.batch_id ?? '')
    if (!accountId || !Number.isInteger(taxYear) || !batchId) {
      return NextResponse.json({ error: 'account_id, tax_year and batch_id are required.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Post-confirm lock.
    const { isClientEditable } = await import('@/lib/tax/review-status')
    const { data: sub } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('review_status')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const rs = sub?.review_status ?? null
    if (rs !== null && !isClientEditable(rs as never)) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before changing answers.' }, { status: 409 })
    }

    // Clients revert their own answers only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: header } = await (supabaseAdmin as any)
      .from('pnl_period_answers')
      .select('id, actor_role')
      .eq('id', batchId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!header) return NextResponse.json({ error: 'Answer not found.' }, { status: 404 })
    if (header.actor_role !== 'client') {
      return NextResponse.json({ error: 'This answer was recorded by our team — message us to change it.' }, { status: 403 })
    }

    const { undoBooksLocationAnswer } = await import('@/lib/tax/books-location-answer')
    const result = await undoBooksLocationAnswer({ accountId, batchId, actorId: user.email ?? user.id })

    switch (result.status) {
      case 'not_found':
        return NextResponse.json({ error: 'Answer not found.' }, { status: 404 })
      case 'already_undone':
        return NextResponse.json({ error: 'This answer was already undone.' }, { status: 409 })
      case 'ok': {
        try {
          const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
          await resetFinancialsAttestation(accountId, taxYear, `client undid location answer ${batchId}`)
        } catch (e) {
          console.error('[portal period-answer-undo] attestation reset failed:', e)
        }
        return NextResponse.json({ ok: true, restored: result.restored, skipped_reanswered: result.skippedReanswered })
      }
    }
  } catch (err) {
    console.error('[portal period-answer-undo] failed:', err)
    return NextResponse.json({ error: 'Could not undo the answer — please try again.' }, { status: 500 })
  }
}
