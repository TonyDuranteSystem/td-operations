/**
 * Move a flow (service_delivery) to any stage — forward or backward — for the
 * flow Workspace clickable stepper. The stepper is a SHORTCUT for the action
 * buttons + Go Back, so this fires ALL real side effects (it is NOT a silent
 * move):
 *
 *   - FORWARD  → advanceServiceDelivery (auto-tasks + client notification +
 *     completion incl. the +1-year renewal-date bump).
 *   - BACKWARD → iterative revertServiceDelivery (deletes the re-opened stages'
 *     documents + undoes the renewal-date bump when leaving "Closed").
 *
 * All orchestration lives in moveServiceDeliveryToStage
 * (lib/operations/move-stage.ts). Body: { target_stage: string }.
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { moveServiceDeliveryToStage } from '@/lib/operations/move-stage'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({}))
    const targetStage: string | undefined =
      typeof body.target_stage === 'string' && body.target_stage.trim()
        ? body.target_stage.trim()
        : undefined

    if (!targetStage) {
      return NextResponse.json({ success: false, error: 'Missing target_stage' }, { status: 400 })
    }

    const result = await moveServiceDeliveryToStage({
      delivery_id: params.id,
      target_stage: targetStage,
      actor: 'flow-stepper',
      notes: `Moved to "${targetStage}" via flow Workspace stepper`,
    })

    if (!result.success) {
      const status =
        result.outcome === 'not_found'
          ? 404
          : result.outcome === 'stage_not_found'
            ? 400
            : 409 // requires_approval / error
      return NextResponse.json(
        { success: false, error: result.error || 'Could not move the flow.', outcome: result.outcome },
        { status },
      )
    }

    return NextResponse.json({
      success: true,
      outcome: result.outcome,
      direction: result.direction,
      to_stage: result.to_stage,
      to_order: result.to_order,
      completed: result.completed ?? false,
      documents_deleted: result.documents_deleted ?? 0,
      renewal_date_reverted: result.renewal_date_reverted ?? false,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
