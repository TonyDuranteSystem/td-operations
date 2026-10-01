/**
 * The required "Suite" step of the Formation / Onboarding workspace. Backs the `suite_panel` stage_layout component.
 *
 * GET  → { success, state }   (lib/operations/suite.ts SuiteStepState: account_suite / reserved_suite / waived / satisfied)
 * POST → { action: 'issue' }                         issues the company's suite (company exists) or RESERVES the next one on
 *                                                    the delivery (formation, no company yet); clears a waiver
 *        { action: 'waive', reason }                 "No suite for this client" — a reason is required; frees a reserved number
 *        { action: 'unwaive' }                       takes the waiver off
 *
 * [id] = service_delivery_id. Staff-only. The stage gate that makes this step REQUIRED lives in advanceServiceDelivery
 * (friendly error) and in the database (service_deliveries rule — no path can skip it).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import {
  getSuiteStepState,
  issueSuiteForDelivery,
  waiveSuiteForDelivery,
  unwaiveSuiteForDelivery,
} from '@/lib/operations/suite'

async function actorName(): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return `dashboard:${user?.email?.split('@')[0] ?? 'staff'}`
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const state = await getSuiteStepState(params.id)
    return NextResponse.json({ success: true, state })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Could not read the suite step.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string }
    const actor = await actorName()
    if (body.action === 'issue') {
      const suite = await issueSuiteForDelivery(params.id, actor)
      return NextResponse.json({ success: true, suite, state: await getSuiteStepState(params.id) })
    }
    if (body.action === 'waive') {
      if (!body.reason || !body.reason.trim()) {
        return NextResponse.json({ success: false, error: 'Give a reason for "No suite for this client".' }, { status: 400 })
      }
      await waiveSuiteForDelivery(params.id, body.reason, actor)
      return NextResponse.json({ success: true, state: await getSuiteStepState(params.id) })
    }
    if (body.action === 'unwaive') {
      await unwaiveSuiteForDelivery(params.id, actor)
      return NextResponse.json({ success: true, state: await getSuiteStepState(params.id) })
    }
    return NextResponse.json({ success: false, error: 'Unknown action.' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Could not update the suite step.' }, { status: 400 })
  }
}
