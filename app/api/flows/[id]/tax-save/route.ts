/**
 * The saved copy of an approved tax questionnaire, for the workspace panel (dev job 7df278cd, Shipment 2).
 *
 *   GET                                   → { success, view }  saved / saving / failed (+ reason and what to do) / not needed,
 *                                           the file (where, version), who approved, and earlier copies waiting for a choice
 *   POST { action: "save" }               → save it now (also the Retry button); returns the fresh view
 *   POST { action: "earlier_copies", choice: "hidden" | "visible" }
 *                                         → staff's choice about the earlier copies; returns the fresh view
 *
 * [id] = service_delivery_id. Staff only. Approve is not involved: it never waits for a save and a failed save never undoes it.
 */

export const dynamic = 'force-dynamic'
// The save copies the client's uploads into storage; the durable job (queued first) finishes the work if this request is cut short.
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createClient } from '@/lib/supabase/server'
import { getUserDisplayName } from '@/lib/auth'
import { chooseEarlierCopies, loadTaxSaveView, saveTaxNow } from '@/lib/tax/tax-save'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const r = await loadTaxSaveView(params.id)
    if (r.ok === false) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
    return NextResponse.json({ success: true, view: r.view }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Could not read the saved copy.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { action?: unknown; choice?: unknown } | null
  try {
    if (body?.action === 'save') {
      const r = await saveTaxNow(params.id)
      if (r.ok === false) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
      return NextResponse.json({ success: true, view: r.view })
    }
    if (body?.action === 'earlier_copies' && (body.choice === 'hidden' || body.choice === 'visible')) {
      let by = 'staff'
      try {
        const { data: { user } } = await createClient().auth.getUser()
        if (user) by = getUserDisplayName(user) || by
      } catch { /* keep the fallback */ }
      const r = await chooseEarlierCopies(params.id, body.choice, by)
      if (r.ok === false) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
      return NextResponse.json({ success: true, view: r.view })
    }
    return NextResponse.json({ success: false, error: 'Send { action: "save" } or { action: "earlier_copies", choice: "hidden" | "visible" }.' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Something went wrong.' }, { status: 500 })
  }
}
