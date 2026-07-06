/**
 * POST /api/tools/pnl/[id]/prior-return — staff sets the workspace's
 * prior-return answer (STAFF ONLY, 2026-07-06).
 *
 * Body: { choice: 'first_year' | 'never_filed' | 'clear' }
 * Writes the SAME PriorReturnCaseRecord shape the client wizard stores, so
 * gate 2 (prior-year tie-out) reads it with zero new machinery. first_year is
 * cross-checked against the linked client's formation date (claim_mismatch on
 * contradiction — surfaced, never silently trusted). 'clear' resets to null
 * (the gate returns to "complete the prior-return step").
 *
 * Guard: never replaces a validated/quarantined prior-return EXTRACTION —
 * real carried-forward balances must not be discardable with one tap.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { buildWorkspacePriorReturnRecord, canStaffSetPriorReturn, type WorkspacePriorReturnChoice } from '@/lib/tax/workspace-prior-return'
import type { PriorReturnCaseRecord } from '@/lib/tax/prior-return-case'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({})) as { choice?: string }
    const choice = body.choice
    if (choice !== 'first_year' && choice !== 'never_filed' && choice !== 'clear') {
      return NextResponse.json({ error: "choice must be 'first_year', 'never_filed' or 'clear'." }, { status: 400 })
    }

    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('id, tax_year, linked_account_id, prior_return_snapshot')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })
    const taxYear = Number(ws.tax_year)
    if (!Number.isInteger(taxYear)) return NextResponse.json({ error: 'Workspace has no tax year.' }, { status: 400 })

    const existing = (ws.prior_return_snapshot ?? null) as PriorReturnCaseRecord | null
    if (!canStaffSetPriorReturn(existing)) {
      return NextResponse.json({ error: 'This workspace carries an extracted prior return — its answer cannot be replaced from here.' }, { status: 409 })
    }

    let record: PriorReturnCaseRecord | null = null
    if (choice !== 'clear') {
      let formationDate: string | null = null
      if (ws.linked_account_id) {
        const { data: acct } = await db.from('accounts').select('formation_date').eq('id', ws.linked_account_id).maybeSingle()
        formationDate = (acct?.formation_date as string | null) ?? null
      }
      record = buildWorkspacePriorReturnRecord({
        choice: choice as WorkspacePriorReturnChoice,
        taxYear,
        formationDate,
        actor: user?.email ?? 'staff',
      })
    }

    const { error } = await db
      .from('pnl_workspaces')
      .update({ prior_return_snapshot: record, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true, prior_return: record ? { case: record.case, status: record.status } : null })
  } catch (err) {
    console.error('[tools/pnl] prior-return set failed:', err)
    return NextResponse.json({ error: 'Could not save the prior-return answer — please try again.' }, { status: 500 })
  }
}
