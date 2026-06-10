'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { TAX_BOARD_ASSIGNEES, type TaxBoardAssignee, isDroppableColumn, isReviewSubstateColumn, resolveDrop } from '@/lib/tax/tax-board'
import { overlayEffectiveStageName } from '@/lib/tax/tax-stage-overlay'
import { advanceServiceDelivery } from '@/lib/service-delivery'

/**
 * Set (or clear) the assignee on a Tax Return service delivery from the board.
 * Low-risk single-field write; no client notification. `assignee === null`
 * clears it ("Unassigned").
 */
export async function assignTaxBoardCard(
  sdId: string,
  assignee: string | null,
): Promise<ActionResult> {
  if (assignee !== null && !TAX_BOARD_ASSIGNEES.includes(assignee as TaxBoardAssignee)) {
    return { success: false, error: `Invalid assignee: ${assignee}` }
  }
  return safeAction(
    async () => {
      const supabase = createClient()
      // eslint-disable-next-line no-restricted-syntax -- board assignee write, scoped single-field, dev_task 7fb26de4
      const { error } = await supabase
        .from('service_deliveries')
        .update({ assigned_to: assignee })
        .eq('id', sdId)
        .eq('service_type', 'Tax Return')
      if (error) throw new Error(error.message)
      revalidatePath('/tax-returns')
    },
    {
      action_type: 'update',
      table_name: 'service_deliveries',
      record_id: sdId,
      summary: `Tax Board assignee → ${assignee ?? 'Unassigned'}`,
      details: { assigned_to: assignee },
    },
  )
}

/**
 * Drag-to-advance a Tax Return SD to a new pipeline stage from the board.
 *
 * Re-validates the move from the DB — never trusts the drag (the client legality
 * in lib/tax/tax-board.ts is mirrored here authoritatively):
 *  - target must be a real, board-visible SD stage (not a review sub-state, not
 *    unknown) — review transitions go through /api/crm/tax-review/action;
 *  - the SD's CURRENT effective stage (SD stage overlaid with review_status)
 *    must itself be a real stage (a card in the review loop is not drag-movable);
 *  - target must differ from the current stage.
 *
 * Advance is SILENT (skip_notify=true, Antonio 2026-06-10): staff board moves
 * don't push the client; their progress tracker reflects the new stage on next
 * load. All tax stages already carry notify_client_email=false + no auto_tasks.
 */
export async function advanceTaxBoardCard(
  sdId: string,
  targetStage: string,
): Promise<ActionResult> {
  return safeAction(
    async () => {
      // Authoritative reads (service-role; sandbox in dev via .env.local).
      const { data: sd, error: sdErr } = await supabaseAdmin
        .from('service_deliveries')
        .select('id, account_id, stage, service_type, status')
        .eq('id', sdId)
        .single()
      if (sdErr || !sd) throw new Error('Service delivery not found')
      if (sd.service_type !== 'Tax Return') throw new Error('Not a Tax Return service delivery')
      if (sd.status === 'completed' || sd.status === 'cancelled') {
        throw new Error('This service delivery is closed')
      }

      const { data: stageRows } = await supabaseAdmin
        .from('pipeline_stages')
        .select('stage_name, stage_order, board_visible')
        .eq('service_type', 'Tax Return')
      const board = (stageRows ?? []).filter(s => s.board_visible)
      const targetIsBoardStage = board.some(s => s.stage_name === targetStage)
      if (!targetIsBoardStage || isReviewSubstateColumn(targetStage)) {
        throw new Error('Invalid drop target')
      }

      // Current effective column = SD stage overlaid with latest review_status.
      const { data: sub } = await supabaseAdmin
        .from('tax_return_submissions')
        .select('review_status, created_at')
        .eq('account_id', sd.account_id ?? '')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const effective =
        overlayEffectiveStageName(
          board.map(s => ({ stage_name: s.stage_name, stage_order: s.stage_order })),
          sd.stage,
          sub?.review_status ?? null,
        ) ?? sd.stage ?? ''
      const sourceRef = { stage_name: effective, isOther: !board.some(s => s.stage_name === effective) }

      const decision = resolveDrop(sourceRef, { stage_name: targetStage, isOther: false })
      if (!decision.ok) throw new Error(decision.reason ?? 'Move not allowed')
      // Belt-and-suspenders: source must be a real draggable column.
      if (!isDroppableColumn(sourceRef)) throw new Error('This return is not drag-movable')

      const result = await advanceServiceDelivery({
        delivery_id: sdId,
        target_stage: targetStage,
        skip_notify: true, // SILENT staff move
        actor: 'dashboard:tax-board',
      })
      if (!result.success) throw new Error(result.error ?? 'Advance failed')
      revalidatePath('/tax-returns')
    },
    {
      action_type: 'update',
      table_name: 'service_deliveries',
      record_id: sdId,
      summary: `Tax Board drag → ${targetStage}`,
      details: { target_stage: targetStage, skip_notify: true },
    },
  )
}
