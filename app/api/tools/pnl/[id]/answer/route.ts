/**
 * POST /api/tools/pnl/[id]/answer — categorize a group of workspace transactions
 * (STAFF ONLY). Mirrors the portal answer route against the ISOLATED workspace
 * table. NO learned-rule writes (sealed leak #2) — a workspace never trains the
 * real client/global categorization rules.
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
    const body = await request.json().catch(() => ({})) as { answer?: string; transaction_ids?: string[] }
    const ids = Array.isArray(body.transaction_ids) ? body.transaction_ids.filter(Boolean) : []
    if (!body.answer || ids.length === 0) {
      return NextResponse.json({ error: 'answer and transaction_ids are required.' }, { status: 400 })
    }

    const { categoryForAnswer } = await import('@/lib/tax/question-groups')
    const mapped = categoryForAnswer(body.answer)
    if (!mapped) return NextResponse.json({ error: `Unknown answer: ${body.answer}` }, { status: 400 })

    // Only re-file rows still in a reviewable state (never override a prior
    // manual decision by re-answering a stale group), scoped to this workspace.
    const { data, error } = await db
      .from('pnl_workspace_transactions')
      .update({ category: mapped.category, subcategory: mapped.subcategory, notes: `manual: staff answer (${body.answer})` })
      .eq('workspace_id', params.id)
      .in('category', ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution'])
      .in('id', ids)
      .select('id')
    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, updated: (data ?? []).length })
  } catch (err) {
    console.error('[tools/pnl] answer failed:', err)
    return NextResponse.json({ error: 'Could not save the answer — please try again.' }, { status: 500 })
  }
}
