/**
 * "Resubmit SS-4" for a Company Formation flow (dev job 25e460aa) — backs the correction panel in the
 * "SS-4 Sent to IRS" stage.
 *
 *   GET  → the SS-4s already archived for this flow's company (when / why / by whom), newest first.
 *   POST { reason } → archive the signed/faxed SS-4 and create a corrected DRAFT through the shared
 *          resubmitSs4 core (lib/operations/ss4-resubmit.ts — the same core the ss4_resubmit MCP tool uses).
 *          Every check runs first; a failure archives nothing. Nothing is sent to the client and the
 *          stage does not move.
 *
 * Staff only. [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createClient } from '@/lib/supabase/server'
import { resubmitSs4 } from '@/lib/operations/ss4-resubmit'

async function accountOf(serviceDeliveryId: string): Promise<string | null | undefined> {
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id')
    .eq('id', serviceDeliveryId)
    .maybeSingle()
  return sd ? ((sd.account_id as string | null) ?? null) : undefined
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const accountId = await accountOf(params.id)
    if (accountId === undefined) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!accountId) return NextResponse.json({ success: true, archived: [] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table, not in generated types
    const { data, error } = await (supabaseAdmin as any)
      .from('ss4_applications_archive')
      .select('id, archived_at, archived_by, archive_reason, status, county_and_state, signed_at')
      .eq('account_id', accountId)
      .order('archived_at', { ascending: false })
    if (error) return NextResponse.json({ success: false, error: `Could not load the archived SS-4s: ${error.message}` }, { status: 500 })
    return NextResponse.json({ success: true, archived: data ?? [] }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason : ''

    const accountId = await accountOf(params.id)
    if (accountId === undefined) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
    if (!accountId) return NextResponse.json({ success: false, error: 'No account linked to this flow yet.' }, { status: 400 })

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    const result = await resubmitSs4({ account_id: accountId, reason, by: user?.email || 'dashboard', source: 'flow-resubmit-ss4' })
    if (!result.ok) {
      const status = result.outcome === 'error' ? 500 : 409
      return NextResponse.json({ success: false, outcome: result.outcome, error: result.message }, { status })
    }
    return NextResponse.json({ success: true, outcome: result.outcome, message: result.message, ss4: result.ss4, previewUrl: result.previewUrl, warnings: result.warnings ?? [] })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
