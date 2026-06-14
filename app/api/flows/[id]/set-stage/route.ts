/**
 * Move a flow (service_delivery) DIRECTLY to any stage — forward or backward —
 * for the flow Workspace clickable stepper.
 *
 * setServiceDeliveryStage (lib/operations/service-delivery.ts) is the single
 * source of truth for this lightweight move: it sets stage / stage_order /
 * stage_entered_at, appends a stage_history entry, and keeps status coherent
 * (terminal target → completed + end_date; otherwise active + cleared
 * end_date). It deliberately does NOT create auto-tasks, notify the client,
 * delete documents, or run the renewal-date bump — those belong to the action
 * buttons (/advance) and Go Back (/revert), which are unchanged.
 *
 * Body: { target_stage: string }
 * [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { setServiceDeliveryStage } from '@/lib/operations/service-delivery'

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

    const result = await setServiceDeliveryStage({
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
            : 409
      return NextResponse.json(
        { success: false, error: result.error || 'Could not move the flow.', outcome: result.outcome },
        { status },
      )
    }

    return NextResponse.json({
      success: true,
      outcome: result.outcome,
      to_stage: result.to_stage,
      to_order: result.to_order,
      completed: result.completed ?? false,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
