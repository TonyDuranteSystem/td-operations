/**
 * Staff-triggered on-demand IRS tracking check — runs the exact same check the daily
 * cron performs (app/api/cron/irs-tracking-check), immediately instead of waiting for
 * the next scheduled pass. Shares the identical decision logic (decideCheckOutcome) and
 * the identical confirm+notify path (applyDeliveryConfirmation) so behavior can never
 * drift between the two triggers.
 *
 * POST /api/flows/[id]/irs-tracking/check-now
 * [id] = service_delivery_id. Staff-only (requireStaffRoute).
 *
 * Refuses (400) when there's nothing to check: no tracking number on file yet, or
 * already confirmed delivered. Unlike the cron, does NOT consult
 * pipeline_stages.tracking_check_enabled first — that flag scopes the automated sweep's
 * cost, not whether a staff member is allowed to ask right now.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { lookupTrackingStatus } from '@/lib/shipstation'
import { decideCheckOutcome, type TrackingRow } from '@/lib/operations/irs-tracking'
import { applyDeliveryConfirmation } from '@/lib/operations/irs-tracking-confirm'

// irs_shipment_tracking isn't in the generated types until Antonio promotes the
// migration to production — untyped surface, mirrors the sibling route in this
// directory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { data: row } = await db
      .from('irs_shipment_tracking')
      .select('service_delivery_id, tracking_number, consecutive_delivered_checks, consecutive_unmatched_checks, delivered_at, no_match_alerted_at, stuck_alerted_at, created_at')
      .eq('service_delivery_id', params.id)
      .maybeSingle()

    if (!row) {
      return NextResponse.json({ success: false, error: 'No tracking number on file for this case yet.' }, { status: 400 })
    }
    if (row.delivered_at) {
      return NextResponse.json({ success: false, error: 'Already confirmed delivered — nothing to check.' }, { status: 400 })
    }

    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, stage, account_id, contact_id')
      .eq('id', params.id)
      .maybeSingle()
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })

    const now = new Date()
    const lookup = await lookupTrackingStatus(row.tracking_number)
    const decision = decideCheckOutcome(row as TrackingRow, lookup, now)

    const { error: patchErr } = await db
      .from('irs_shipment_tracking')
      .update(decision.patch)
      .eq('service_delivery_id', row.service_delivery_id)
      .eq('tracking_number', row.tracking_number)
    if (patchErr) throw new Error(patchErr.message)

    let justConfirmed = false
    if (decision.confirmDelivered) {
      const confirmResult = await applyDeliveryConfirmation(sd, row, decision.deliveredAt as string)
      justConfirmed = confirmResult.justConfirmed
    }

    const { data: fresh } = await db
      .from('irs_shipment_tracking')
      .select('courier, tracking_number, status, delivered_at, matched_ship_date')
      .eq('service_delivery_id', params.id)
      .maybeSingle()

    return NextResponse.json({ success: true, justConfirmed, tracking: fresh })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
