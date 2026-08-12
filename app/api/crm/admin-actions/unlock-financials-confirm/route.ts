/**
 * POST /api/crm/admin-actions/unlock-financials-confirm
 *
 * STAFF-ONLY override of the failed-statement-file HARD BLOCK on the client's
 * tax-financials confirmation (card 4a39e0fd, Antonio's binding ruling
 * 2026-08-12): a failed/quarantined statement file locks the client's Confirm;
 * only staff can unlock, a reason is REQUIRED, the unlock is logged, and the
 * client gets a portal chat message explaining it.
 *
 * Body: { account_id, tax_year, reason }
 *
 * The override lives in the resolved submission's financials_meta
 * (failed_files_override: { by, reason, at }) — the attest route reads exactly
 * this. It survives until the file set changes: any new upload/delete resets
 * the attestation AND clears this override (a fresh mutation invalidates the
 * judgment that the hole was acceptable).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canPerform } from '@/lib/permissions'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // 'advance_stage' = the team-level permission tier (Luca included) — the
  // unlock is a staff judgment, not an admin-only system action.
  if (!canPerform(user, 'advance_stage')) {
    return NextResponse.json({ success: false, detail: 'Staff access required' }, { status: 403 })
  }

  try {
    const { account_id, tax_year, reason } = (await req.json()) as {
      account_id?: string
      tax_year?: number
      reason?: string
    }
    if (!account_id || !Number.isInteger(tax_year)) {
      return NextResponse.json({ success: false, detail: 'account_id and tax_year are required' }, { status: 400 })
    }

    const { unlockFinancialsConfirm } = await import('@/lib/tax/confirm-unlock')
    const r = await unlockFinancialsConfirm({
      accountId: account_id,
      taxYear: tax_year as number,
      reason: String(reason ?? ''),
      actor: user?.email ?? 'staff',
    })
    if (!r.ok) return NextResponse.json({ success: false, detail: r.error }, { status: 400 })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[unlock-financials-confirm]', err)
    return NextResponse.json({ success: false, detail: 'Could not unlock — please try again.' }, { status: 500 })
  }
}
