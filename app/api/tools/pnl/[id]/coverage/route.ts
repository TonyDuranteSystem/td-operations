/**
 * POST /api/tools/pnl/[id]/coverage — STAFF ONLY.
 *   { question_key, answer: 'no_activity' | 'had_activity' }
 *
 * The workspace twin of POST /api/portal/tax-financials/coverage — same
 * question/answer contract (lib/tax/coverage.ts), but writes to this
 * workspace's own `coverage_answers` column instead of a real client
 * submission's `financials_meta`. Built as part of the 2026-08-20 hard-stop
 * plan: the shared review component already called this exact endpoint
 * (`${API}/coverage`) for workspace mode — it simply didn't exist yet, so
 * every coverage-question Yes/No tap would have 404'd the moment coverage
 * detection went live in the staff tool (see coverage() wiring in
 * app/api/tools/pnl/[id]/route.ts).
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

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({}))
    const questionKey = String(body.question_key ?? '')
    const answer = String(body.answer ?? '')
    if (!questionKey || !['no_activity', 'had_activity'].includes(answer)) {
      return NextResponse.json({ error: 'question_key and a valid answer required' }, { status: 400 })
    }

    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('id, coverage_answers')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })

    const answers = (ws.coverage_answers ?? {}) as Record<string, unknown>
    answers[questionKey] = { answer, at: new Date().toISOString() }

    const { error } = await db
      .from('pnl_workspaces')
      .update({ coverage_answers: answers, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ recorded: true })
  } catch (err) {
    console.error('[tools/pnl] coverage answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
