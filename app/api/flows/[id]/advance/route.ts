/**
 * Advance a flow (service_delivery) to an explicit target stage. Backs the flow
 * Workspace action_buttons "Mark as Completed" button, which advances AR/RA
 * flows to their final "Closed" stage.
 *
 * advanceServiceDelivery is the SINGLE SOURCE OF TRUTH for stage-advance side
 * effects (stage_history, auto-tasks, portal notify, and — for State Annual
 * Report / State RA Renewal reaching "Closed" — the +1-year renewal-date bump
 * and completion status). We pass target_stage so the move is explicit (e.g.
 * jumping straight to "Closed" from an intermediate receipt stage) rather than
 * a single next-stage hop.
 *
 * Body: { target_stage: string }
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { syncTaxRevisionRequest } from '@/lib/tax/sync-flow-revision'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const serviceDeliveryId = params.id
    const body = await req.json().catch(() => ({}))
    const targetStage: string | undefined =
      typeof body.target_stage === 'string' ? body.target_stage : undefined
    // Staff-confirmed formation (filing) date — sent by the workspace when
    // advancing a Company Formation into "Articles Received". ISO YYYY-MM-DD.
    const formationDate: string | undefined =
      typeof body.formation_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.formation_date)
        ? body.formation_date
        : undefined

    if (!targetStage) {
      return NextResponse.json(
        { success: false, error: 'Missing target_stage' },
        { status: 400 },
      )
    }

    const result = await advanceServiceDelivery({
      delivery_id: serviceDeliveryId,
      target_stage: targetStage,
      formation_date: formationDate,
      actor: 'flow-action',
      notes: `Advanced to "${targetStage}" via flow Workspace action`,
    })

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result.error || 'Could not advance the flow.',
          requires_approval: result.requires_approval ?? false,
        },
        { status: 409 },
      )
    }

    // Tax Return "Request Changes": the stage move alone never let the client
    // edit — the portal gate reads the submission's review_status, not the SD
    // stage. Mirror the stage into the review state machine so the client's
    // wizard actually unlocks, the audit trail records the reopen, and the
    // client is notified. Best-effort: a sync failure must not fail the advance
    // the staff member already saw succeed. (Carasso edit-button fix 2026-07-23.)
    let revisionSync: Awaited<ReturnType<typeof syncTaxRevisionRequest>> | null = null
    if (result.to_stage === 'Revision Requested') {
      try {
        revisionSync = await syncTaxRevisionRequest({
          serviceDeliveryId,
          by: 'flow-action',
        })
      } catch (syncErr) {
        console.error('[flows/advance] tax revision sync failed (non-fatal):', syncErr)
        revisionSync = { status: 'error', detail: syncErr instanceof Error ? syncErr.message : String(syncErr) }
      }
    }

    // Surface to staff when the client was NOT actually unlocked. The stage
    // moved regardless (best-effort sync), so a silent failure would leave staff
    // believing the client can edit when he cannot. 'written' (just unlocked)
    // and 'already_revision_requested' (already open) are the only success
    // states; everything else needs a visible nudge to re-press or act.
    // (bug-hunter #4, 2026-07-24.)
    let warning: string | null = null
    if (revisionSync && revisionSync.status !== 'written' && revisionSync.status !== 'already_revision_requested') {
      warning =
        revisionSync.status === 'confirmed_locked'
          ? "This return is already confirmed — reopen it before requesting changes; the client was NOT unlocked."
          : "Heads up: the client's tax form was not unlocked for editing. Press Request Changes again, or check the submission."
    }

    return NextResponse.json({
      success: true,
      to_stage: result.to_stage,
      is_completed: result.is_completed,
      auto_triggers: result.auto_triggers,
      revision_sync: revisionSync,
      warning,
    })
  } catch (e) {
    // "Stage not found" / "Already at final stage" / approval guards land here.
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
