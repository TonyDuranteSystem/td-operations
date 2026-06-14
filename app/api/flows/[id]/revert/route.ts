/**
 * Revert a flow (service_delivery) ONE stage backwards — the inverse of the
 * advance route. Backs the flow Workspace "← Go Back" button.
 *
 * revertServiceDelivery (lib/operations/service-delivery.ts) is the single
 * source of truth for the revert side effects: deletes the documents stamped
 * with the previous (target) stage, moves the SD back by name (stage /
 * stage_order / stage_entered_at + stage_history), resets a completed final
 * stage to active, and — for State Annual Report / State RA Renewal leaving
 * "Closed" — undoes the +1-year renewal-date bump.
 *
 * No body required. [id] = service_delivery_id.
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { revertServiceDelivery } from '@/lib/operations/service-delivery'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const result = await revertServiceDelivery({
      delivery_id: params.id,
      actor: 'flow-action',
      notes: 'Reverted via flow Workspace "Go Back"',
    })

    if (!result.success) {
      const status =
        result.outcome === 'not_found'
          ? 404
          : result.outcome === 'at_first_stage'
            ? 400
            : 409
      return NextResponse.json(
        { success: false, error: result.error || 'Could not go back.', outcome: result.outcome },
        { status },
      )
    }

    return NextResponse.json({
      success: true,
      to_stage: result.to_stage,
      documents_deleted: result.documents_deleted,
      status_reset: result.status_reset,
      renewal_date_reverted: result.renewal_date_reverted,
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }
}
