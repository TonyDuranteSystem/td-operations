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
 * Body: { target_stage: string, skip_company_close?: true }
 *   skip_company_close — Company Closure only: finish the job WITHOUT closing the company (the question offers it when the client
 *   wrote a different company in the wizard than the one the job is linked to).
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { syncTaxRevisionRequest } from '@/lib/tax/sync-flow-revision'
import { approveTaxSubmission, approvalNeedsWarning, type ApproveTaxSubmissionResult } from '@/lib/tax/approve-submission'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
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
    // Staff-supplied LLC type (workspace Articles-upload modal) — the
    // materializer's highest-priority entity-type source. Only SMLLC/MMLLC.
    const entityType: 'SMLLC' | 'MMLLC' | undefined =
      body.entity_type === 'SMLLC' || body.entity_type === 'MMLLC' ? body.entity_type : undefined

    if (!targetStage) {
      return NextResponse.json(
        { success: false, error: 'Missing target_stage' },
        { status: 400 },
      )
    }

    // Tax Return "Approve": note where the job was BEFORE the move, to know afterwards whether this move released a reviewed submission
    // (the review block is stage_order 45-49; "Data Received" is 50).
    const { data: before } = await supabaseAdmin
      .from('service_deliveries')
      .select('service_type, stage_order')
      .eq('id', serviceDeliveryId)
      .maybeSingle()

    const result = await advanceServiceDelivery({
      delivery_id: serviceDeliveryId,
      target_stage: targetStage,
      skip_company_close: body.skip_company_close === true,
      formation_date: formationDate,
      entity_type: entityType,
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

    // Tax Return "Approve" (Under Review → Data Received): approving IS the release now — the client's Confirm step was removed
    // (Antonio, 2026-11-06). Lock the reviewed submission and finish the tax record, the same as the What's New card's Approve does.
    // Best-effort: a failure must not undo the move the staff member saw succeed, but it is shown (below).
    let approval: ApproveTaxSubmissionResult | null = null
    const fromOrder = before?.stage_order ?? 0
    if (before?.service_type === 'Tax Return' && result.to_stage === 'Data Received' && fromOrder >= 45 && fromOrder < 50) {
      try {
        approval = await approveTaxSubmission({ serviceDeliveryId, by: 'flow-action' })
      } catch (approveErr) {
        console.error('[flows/advance] tax approval release failed (non-fatal):', approveErr)
        approval = { status: 'error', detail: approveErr instanceof Error ? approveErr.message : String(approveErr) }
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

    if (approval && approvalNeedsWarning(approval.status)) {
      warning =
        approval.status === 'not_approvable'
          ? "Moved to Data Received, but the client's tax form was NOT released: the client is still editing it (changes were requested). Check the submission before preparing the return."
          : "Moved to Data Received, but the client's tax form could not be released automatically. Open the tax submission (What's New card) and approve it there."
    }

    // Company-Formation materialization: deterministic failures already refuse
    // the advance up-front, so a failure here is a transient runtime error —
    // the stage moved but NO account exists. Surface it loudly (the old
    // free-text-only auto_triggers path is what made the Covelli failure
    // silent).
    const mat = result.materialization
    if (mat && mat.error) {
      warning = `The stage moved, but the company record was NOT created: ${mat.error} Fix the cause, go back one stage, and advance again.`
    }

    // Company Closure: the job finished, but a step of closing the company failed — say so (it used to report success while the
    // company stayed open). Company Closure Part C, dev job a6bbea09.
    const closureProblems = (result.auto_triggers ?? []).filter((t: string) => t.startsWith('Closure problem: '))
    if (closureProblems.length > 0) {
      warning = `The job finished, but closing the company did not fully work: ${closureProblems.map((t: string) => t.slice('Closure problem: '.length)).join(' · ')}. Check the company before relying on it.`
    }

    return NextResponse.json({
      success: true,
      to_stage: result.to_stage,
      is_completed: result.is_completed,
      auto_triggers: result.auto_triggers,
      materialization: result.materialization ?? null,
      revision_sync: revisionSync,
      approval_release: approval,
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
