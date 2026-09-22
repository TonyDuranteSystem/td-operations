/**
 * Mark the Registered Agent as switched to Harbor Compliance for a Client
 * Onboarding flow — staff-confirmed, not an API push (Antonio, 2026-09-22:
 * "that fucking button must open the website for us to do switch. once is
 * done, we will confirm in the workspace and the system will update the
 * crm"). Staff do the actual switch by hand on Harbor Compliance's own
 * site; this just advances the SD to its final stage once they say it's
 * done, which is also what retires this step's card everywhere it shows.
 *
 * POST → { success, message } | { success:false, error }
 * [id] = onboarding_submissions.id.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { advanceStageIfAt } from '@/lib/operations/service-delivery'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('id, account_id, reviewed_at')
      .eq('id', params.id)
      .maybeSingle()

    if (subErr || !sub) {
      return NextResponse.json({ success: false, error: 'Submission not found' }, { status: 404 })
    }
    if (!sub.reviewed_at || !sub.account_id) {
      return NextResponse.json(
        { success: false, error: 'This onboarding has not been reviewed and confirmed yet — nothing to switch the RA on.' },
        { status: 400 },
      )
    }

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, stage')
      .eq('account_id', sub.account_id)
      .eq('service_type', 'Client Onboarding')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (sdErr || !sd) {
      return NextResponse.json({ success: false, error: 'No active Client Onboarding record found for this account' }, { status: 404 })
    }

    const { data: finalStage } = await supabaseAdmin
      .from('pipeline_stages')
      .select('stage_name')
      .eq('service_type', 'Client Onboarding')
      .order('stage_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!finalStage) {
      return NextResponse.json({ success: false, error: 'Client Onboarding has no pipeline stages configured' }, { status: 500 })
    }
    if (sd.stage === finalStage.stage_name) {
      return NextResponse.json({ success: true, message: 'Already confirmed — Registered Agent switch was already recorded.' })
    }

    const result = await advanceStageIfAt({
      delivery_id: sd.id,
      if_current_stage: sd.stage || '',
      target_stage: finalStage.stage_name,
      actor: 'staff (onboarding workspace)',
      notes: 'Registered Agent switched to Harbor Compliance — staff-confirmed.',
    })

    if (!result.advanced) {
      return NextResponse.json({ success: false, error: result.reason || 'Could not advance the stage' }, { status: 409 })
    }

    return NextResponse.json({ success: true, message: `Registered Agent switch confirmed — moved to ${finalStage.stage_name}.` })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
