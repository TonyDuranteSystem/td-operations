/**
 * Staff entry of the tracking number for an ITIN package mailed to the IRS. Backs the
 * `irs_tracking_entry` stage_layout component on both "Submitted to IRS" and
 * "IRS Processing" (the second so the 3 real cases already past the first stage when
 * this shipped can be backfilled from their existing mailing-receipt scan).
 *
 * GET  → { success, tracking: { courier, tracking_number, status, delivered_at,
 *          matched_ship_date, duplicate_of } | null }
 * POST → { courier, tracking_number } → validates, upserts. A same-value re-save is a
 *   no-op on the check-owned fields (status/checked_at/counters/delivered_at/alert
 *   flags) — only an ACTUAL change to courier or the number resets them, so an idle
 *   re-click on an already-confirmed case can never wipe the confirmation and cause a
 *   duplicate client notification. `created_at` (the immutable 150-day-safety-net clock)
 *   is never included in the upsert payload, so it is set once on first insert and left
 *   alone by every later save.
 *
 * [id] = service_delivery_id. Staff-only (requireStaffRoute) — this table has no
 * client-facing path at all.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { isCourier } from '@/lib/flows/courier'

const MAX_TRACKING_LEN = 100

interface TrackingRow {
  service_delivery_id: string
  courier: string | null
  tracking_number: string
  status: string | null
  delivered_at: string | null
  matched_ship_date: string | null
}

// irs_shipment_tracking isn't in the generated types until Antonio promotes the
// migration to production (sandbox-only until then) — untyped surface, mirrors every
// other new-column/new-table site in this codebase (documents/route.ts, save-ein/route.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function findDuplicate(trackingNumber: string, excludeSdId: string) {
  // .limit(1) + array access, not .maybeSingle() — this is a soft, informational
  // warning (never a hard block), so it must never throw even in the unlikely event
  // more than one OTHER case already shares this number.
  const { data: others } = await db
    .from('irs_shipment_tracking')
    .select('service_delivery_id')
    .eq('tracking_number', trackingNumber)
    .neq('service_delivery_id', excludeSdId)
    .limit(1)
  const other = others?.[0]
  if (!other) return null

  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id, contact_id')
    .eq('id', other.service_delivery_id)
    .maybeSingle()
  if (!sd) return { service_delivery_id: other.service_delivery_id as string, company_name: null }

  let companyName: string | null = null
  if (sd.account_id) {
    const { data: acct } = await supabaseAdmin.from('accounts').select('company_name').eq('id', sd.account_id).maybeSingle()
    companyName = acct?.company_name ?? null
  } else if (sd.contact_id) {
    const { data: contact } = await supabaseAdmin.from('contacts').select('full_name').eq('id', sd.contact_id).maybeSingle()
    companyName = contact?.full_name ?? null
  }
  return { service_delivery_id: other.service_delivery_id as string, company_name: companyName }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { data: row } = await db
      .from('irs_shipment_tracking')
      .select('service_delivery_id, courier, tracking_number, status, delivered_at, matched_ship_date')
      .eq('service_delivery_id', params.id)
      .maybeSingle()

    if (!row) return NextResponse.json({ success: true, tracking: null })

    const duplicate_of = await findDuplicate((row as TrackingRow).tracking_number, params.id)
    return NextResponse.json({
      success: true,
      tracking: {
        courier: row.courier,
        tracking_number: row.tracking_number,
        status: row.status,
        delivered_at: row.delivered_at,
        matched_ship_date: row.matched_ship_date,
        duplicate_of,
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const body = await req.json().catch(() => ({}))
    const courier = typeof body.courier === 'string' ? body.courier.trim() : ''
    const trackingNumber = typeof body.tracking_number === 'string' ? body.tracking_number.trim() : ''

    if (!isCourier(courier)) {
      return NextResponse.json({ success: false, error: 'Please choose a valid courier.' }, { status: 400 })
    }
    if (!trackingNumber) {
      return NextResponse.json({ success: false, error: 'Please enter a tracking number.' }, { status: 400 })
    }
    if (trackingNumber.length > MAX_TRACKING_LEN) {
      return NextResponse.json(
        { success: false, error: `Tracking number is too long (max ${MAX_TRACKING_LEN} characters).` },
        { status: 400 },
      )
    }

    const { data: sd } = await supabaseAdmin.from('service_deliveries').select('id').eq('id', params.id).maybeSingle()
    if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })

    const { data: existing } = await db
      .from('irs_shipment_tracking')
      .select('courier, tracking_number, status, delivered_at, matched_ship_date')
      .eq('service_delivery_id', params.id)
      .maybeSingle()

    const unchanged = existing && existing.courier === courier && existing.tracking_number === trackingNumber

    if (!unchanged) {
      // A real change (or first entry): reset every check-owned field. created_at is
      // deliberately absent from this payload — on INSERT the column default (now())
      // applies; on UPDATE (conflict), a column absent from the payload is left alone.
      const { error: upsertErr } = await db.from('irs_shipment_tracking').upsert(
        {
          service_delivery_id: params.id,
          courier,
          tracking_number: trackingNumber,
          submitted_at: new Date().toISOString(),
          status: null,
          checked_at: null,
          matched_ship_date: null,
          consecutive_delivered_checks: 0,
          delivered_at: null,
          consecutive_unmatched_checks: 0,
          no_match_alerted_at: null,
          stuck_alerted_at: null,
        },
        { onConflict: 'service_delivery_id' },
      )
      if (upsertErr) throw new Error(upsertErr.message)
    }

    const duplicate_of = await findDuplicate(trackingNumber, params.id)
    return NextResponse.json({
      success: true,
      tracking: {
        courier,
        tracking_number: trackingNumber,
        status: unchanged ? existing.status ?? null : null,
        delivered_at: unchanged ? existing.delivered_at ?? null : null,
        matched_ship_date: unchanged ? existing.matched_ship_date ?? null : null,
        duplicate_of,
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
