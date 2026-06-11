/**
 * POST /api/portal/tax-financials/attest — { account_id, tax_year }
 *
 * The financials attestation (Slice 8, master plan §3.7 + W5): the client
 * declares the generated P&L / Balance Sheet numbers are true. Stored ON THE
 * SUBMISSION ROW (confirmation_accepted + client_ip + client_user_agent +
 * a review_history entry) — it does NOT touch review_status; the existing
 * staff-review → approve → final-confirm machine is unchanged.
 *
 * HARD GATE: refused while any blocking gate fails (gate 6 — uncategorized
 * must be zero). OWNER-ONLY — attestation is signing-like, never a teammate's.
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
    // Staff pass isAccountOwner, but the attestation is the CLIENT's act alone.
    if ((user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client') {
      return NextResponse.json({ error: 'Only the client can attest their financials.' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // The hard gate: every blocking gate must pass right now.
    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)
    if (!view.canConfirm) {
      const blocked = view.gates.filter(g => g.blocking && g.status === 'fail').map(g => g.detail).join(' ')
      return NextResponse.json({ error: blocked || 'Not everything is verified yet.' }, { status: 422 })
    }

    const { data: sub } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('id, review_history, confirmation_accepted')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sub) return NextResponse.json({ error: 'No submission found for this year.' }, { status: 404 })

    const history = Array.isArray(sub.review_history) ? sub.review_history : []
    const entry = {
      at: new Date().toISOString(),
      actor: 'client',
      event: 'financials_attested',
      note: `Client attested the generated P&L and Balance Sheet for ${taxYear} (gates: ${view.gates.map(g => `${g.id}=${g.status}`).join(', ')}).`,
    }
    const { error } = await supabaseAdmin
      .from('tax_return_submissions')
      .update({
        confirmation_accepted: true,
        client_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        client_user_agent: request.headers.get('user-agent') ?? null,
        review_history: [...history, entry],
      })
      .eq('id', sub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ attested: true, already: sub.confirmation_accepted === true })
  } catch (err) {
    console.error('[tax-financials] attest failed:', err)
    return NextResponse.json({ error: 'Could not record your confirmation — please try again.' }, { status: 500 })
  }
}
