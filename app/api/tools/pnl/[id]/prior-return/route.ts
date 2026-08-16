/**
 * POST /api/tools/pnl/[id]/prior-return — staff sets the workspace's
 * prior-return answer (STAFF ONLY, 2026-07-06).
 *
 * Body: { choice: 'first_year' | 'never_filed' | 'clear' | 'corrected' }
 * The first three write the SAME PriorReturnCaseRecord shape the client
 * wizard stores, so gate 2 (prior-year tie-out) reads it with zero new
 * machinery. first_year is cross-checked against the linked client's
 * formation date (claim_mismatch on contradiction — surfaced, never silently
 * trusted). 'clear' resets to null (the gate returns to "complete the
 * prior-return step"). Guard: these three never replace a validated/
 * quarantined prior-return EXTRACTION — real carried-forward balances must
 * not be discardable with one tap.
 *
 * 'corrected' (added for dev_task d909e086 — the standalone tool is a real
 * client-facing delivery path too, confirmed round-3, and had this exact same
 * gap as the account-side one) is DELIBERATELY EXEMPT from that guard: it is
 * staff directly entering the true figures because the current answer —
 * including an already-"validated" one — is known to be wrong. That IS the
 * point; canStaffSetPriorReturn is never consulted for this choice.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { buildWorkspacePriorReturnRecord, canStaffSetPriorReturn, type WorkspacePriorReturnChoice } from '@/lib/tax/workspace-prior-return'
import { buildStaffCorrectionRecord, type PriorReturnCaseRecord } from '@/lib/tax/prior-return-case'
import { validateCorrectionPayload } from '@/lib/tax/prior-return-correction'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    const choice = body.choice
    if (choice !== 'first_year' && choice !== 'never_filed' && choice !== 'clear' && choice !== 'corrected') {
      return NextResponse.json({ error: "choice must be 'first_year', 'never_filed', 'clear', or 'corrected'." }, { status: 400 })
    }

    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('id, tax_year, linked_account_id, prior_return_snapshot, updated_at')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })
    const taxYear = Number(ws.tax_year)
    if (!Number.isInteger(taxYear)) return NextResponse.json({ error: 'Workspace has no tax year.' }, { status: 400 })

    if (choice === 'corrected') {
      const validated = validateCorrectionPayload(body)
      if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 400 })
      const record = buildStaffCorrectionRecord(
        { beginning_cash: validated.value.beginning_cash, beginning_cta: validated.value.beginning_cta, members: validated.value.members, unresolved_members: [] },
        taxYear - 1,
        user?.email ?? 'staff',
        new Date().toISOString(),
      )
      // Optimistic concurrency (round-4 minor: the account-side routes had
      // this guard, the workspace's 'corrected' choice originally did not,
      // even though the workspace is explicitly multi-staff-used). Optional
      // on the wire so a caller that never sends it still works — but when a
      // value IS sent, it must match, atomically (.eq on the UPDATE itself,
      // not just compared beforehand in JS).
      const expectedUpdatedAt = body.expected_updated_at
      let q = db
        .from('pnl_workspaces')
        .update({ prior_return_snapshot: record, updated_at: new Date().toISOString() })
        .eq('id', workspaceId)
      if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt) q = q.eq('updated_at', expectedUpdatedAt)
      const { data: correctedUpdated, error: correctedErr } = await q.select('id')
      if (correctedErr) throw new Error(correctedErr.message)
      if (typeof expectedUpdatedAt === 'string' && expectedUpdatedAt && (!correctedUpdated || correctedUpdated.length === 0)) {
        return NextResponse.json({ error: 'STALE_EDIT', message: 'This workspace was changed by someone else since you loaded it — refresh and try again.' }, { status: 409 })
      }
      return NextResponse.json({ ok: true, prior_return: { case: record.case, status: record.status } })
    }

    const existing = (ws.prior_return_snapshot ?? null) as PriorReturnCaseRecord | null
    if (!canStaffSetPriorReturn(existing)) {
      return NextResponse.json({ error: 'This workspace carries an extracted prior return — its answer cannot be replaced from here. Use "Enter corrected numbers" instead.' }, { status: 409 })
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
