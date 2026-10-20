/**
 * POST /api/tools/fax/claim — staff say what happened to a send that was never confirmed (a `fax_claim` row in Fax History).
 * Body: { id, outcome: 'not_sent' | 'sent' }. Only after looking in Faxage. 'not_sent' removes the claim (the same fax may be sent again);
 * 'sent' turns it into a normal history row (job id unknown, marked as set by hand). Staff only; only a still-unresolved claim.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  const outcome = body.outcome === 'not_sent' || body.outcome === 'sent' ? body.outcome : null
  if (!id || !outcome) return NextResponse.json({ error: 'Say which fax and what happened.' }, { status: 400 })

  const { data: row, error } = await supabaseAdmin.from('action_log').select('id, action_type, details').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: 'Could not look up that fax. Please try again.' }, { status: 503 })
  if (!row || row.action_type !== 'fax_claim') return NextResponse.json({ error: 'That fax is not waiting for an answer.' }, { status: 404 })

  if (outcome === 'not_sent') {
    const { error: delErr } = await supabaseAdmin.from('action_log').delete().eq('id', id)
    if (delErr) return NextResponse.json({ error: 'Could not save your answer. Please try again.' }, { status: 503 })
  } else {
    const details = { ...((row.details as Record<string, unknown> | null) ?? {}), outcome_set_by_hand: user?.email || 'staff', outcome_set_at: new Date().toISOString(), filing_status: 'unknown' }
    const { error: upErr } = await supabaseAdmin.from('action_log').update({ action_type: 'fax_sent', summary: 'Fax sent (confirmed by hand in Faxage)', details } as never).eq('id', id)
    if (upErr) return NextResponse.json({ error: 'Could not save your answer. Please try again.' }, { status: 503 })
  }
  return NextResponse.json({ success: true, outcome })
}
