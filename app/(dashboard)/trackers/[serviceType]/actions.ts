'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { completeSD } from '@/lib/operations/service-delivery'
import { normalizeStageHistory, type StageHistoryEntry } from '@/lib/stage-history-helpers'
import { safeAction, type ActionResult } from '@/lib/server-action'
import type { DryRunResult } from '@/lib/operations/destructive'

export async function advanceDeliveryStage(
  deliveryId: string,
  targetStage: string,
  _stageOrder: number,
  notes?: string,
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  try {
    const result = await advanceServiceDelivery({
      delivery_id: deliveryId,
      target_stage: targetStage,
      notes,
      actor: 'crm-tracker',
    })

    revalidatePath('/trackers')
    return {
      success: result.success,
      error: result.error,
      auto_triggers: result.auto_triggers,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

export async function updateDeliveryNotes(
  deliveryId: string,
  notes: string,
  updatedAt: string,
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw service_deliveries.update; extract to lib/operations/service-delivery.ts per dev_task 7ebb1e0c
  const { error } = await supabaseAdmin
    .from('service_deliveries')
    .update({ notes, updated_at: new Date().toISOString() })
    .eq('id', deliveryId)
    .eq('updated_at', updatedAt) // Optimistic lock

  if (error) return { success: false, error: error.message }

  revalidatePath('/trackers')
  return { success: true }
}

export async function reassignDelivery(
  deliveryId: string,
  assignedTo: string,
  updatedAt: string,
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw service_deliveries.update; extract to lib/operations/service-delivery.ts per dev_task 7ebb1e0c
  const { error } = await supabaseAdmin
    .from('service_deliveries')
    .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
    .eq('id', deliveryId)
    .eq('updated_at', updatedAt)

  if (error) return { success: false, error: error.message }

  revalidatePath('/trackers')
  return { success: true }
}

/**
 * Resume an on_hold service delivery — flips status from 'on_hold' back to
 * 'active'. The primary use is the tax-season pause: the global
 * tax_season_paused flag + the reactivation cron handle the common case,
 * but staff sometimes need a manual override for a specific client (e.g.
 * an urgent tax return that must be processed despite the pause). Safe
 * no-op if the SD isn't on_hold.
 */
export async function resumeDelivery(deliveryId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, status')
      .eq('id', deliveryId)
      .maybeSingle()
    if (!sd) throw new Error('Service delivery not found')
    if (sd.status !== 'on_hold') {
      throw new Error(`Can only resume on_hold services. Current status: ${sd.status}`)
    }

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', deliveryId)
      .eq('status', 'on_hold')
    if (error) throw new Error(error.message)

    revalidatePath('/trackers')
  })
}

export async function completeDelivery(deliveryId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  // Route through completeSD — it resolves the final stage from
  // pipeline_stages (max stage_order per service_type) instead of
  // hardcoding "Completed", so the previous raw-write fallback is
  // unnecessary. P3.4 #4 cleanup.
  try {
    const result = await completeSD({
      delivery_id: deliveryId,
      actor: 'crm-tracker',
    })
    revalidatePath('/trackers')
    return {
      success: result.success,
      error: result.error,
      auto_triggers: result.auto_triggers,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── P3.4 #4 — read stage history for a delivery ───

export interface StageHistoryResponse {
  success: boolean
  entries: StageHistoryEntry[]
  error: string | null
}

export async function getDeliveryStageHistory(
  deliveryId: string,
): Promise<StageHistoryResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, entries: [], error: 'Unauthorized' }

  const { data, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('stage_history')
    .eq('id', deliveryId)
    .single()

  if (error) return { success: false, entries: [], error: error.message }
  if (!data) return { success: false, entries: [], error: 'Service delivery not found' }

  return { success: true, entries: normalizeStageHistory(data.stage_history), error: null }
}

// ─── P3.9 — cancel + delete service delivery ─────────

export async function cancelDelivery(deliveryId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_name, service_type, status, account_id')
      .eq('id', deliveryId)
      .maybeSingle()
    if (!sd) throw new Error('Service delivery not found')
    if (sd.status === 'cancelled') throw new Error('Already cancelled')

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .update({
        status: 'cancelled',
        end_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId)
    if (error) throw new Error(error.message)

    // Auto-close linked tasks (same behavior as contact-actions cancel_service).
    const { updateTasksBulk } = await import('@/lib/operations/task')
    await updateTasksBulk({
      delivery_id: deliveryId,
      status_in: ['To Do', 'In Progress', 'Waiting'],
      patch: { status: 'Done' },
      actor: 'crm-tracker',
      summary: `Auto-closed tasks for cancelled service ${sd.service_name || sd.service_type}`,
      account_id: sd.account_id ?? undefined,
    })

    revalidatePath('/trackers')
  }, {
    action_type: 'update',
    table_name: 'service_deliveries',
    record_id: deliveryId,
    summary: 'Service delivery cancelled',
  })
}

export async function deliveryDeletePreview(
  deliveryId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_name, service_type, stage, status, assigned_to, account_id')
      .eq('id', deliveryId)
      .maybeSingle()
    if (!sd) return { success: false, error: 'Service delivery not found' }

    const [{ count: openTaskCount }, { count: totalTaskCount }] = await Promise.all([
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('delivery_id', deliveryId)
        .in('status', ['To Do', 'In Progress', 'Waiting']),
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('delivery_id', deliveryId),
    ])

    const isCompleted = sd.status === 'completed'

    return {
      success: true,
      preview: {
        affected: {
          service_delivery: 1,
          linked_tasks: totalTaskCount ?? 0,
          open_tasks: openTaskCount ?? 0,
        },
        items: [
          {
            label: `${sd.service_name ?? sd.service_type ?? 'Service'}`,
            details: [
              sd.stage ?? '',
              sd.status ?? '',
              sd.assigned_to ? `assigned ${sd.assigned_to}` : '',
            ].filter(Boolean) as string[],
          },
          ...((totalTaskCount ?? 0) > 0
            ? [{
                label: `${totalTaskCount} linked task${totalTaskCount === 1 ? '' : 's'} will keep their delivery_id pointer removed`,
                details: [`${openTaskCount ?? 0} still open`],
              }]
            : []),
        ],
        warnings: [
          'The delivery row is removed. Linked tasks are not deleted but lose their delivery reference.',
          'Prefer Cancel over Delete if the client should still see a cancelled record in their history.',
        ],
        blocker: isCompleted
          ? 'This delivery is Completed. Deleting a completed service corrupts history — leave it for audit trail.'
          : undefined,
        record_label: sd.service_name ?? deliveryId,
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

export async function deleteDelivery(deliveryId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, status')
      .eq('id', deliveryId)
      .maybeSingle()
    if (!sd) throw new Error('Service delivery not found')
    if (sd.status === 'completed') throw new Error('Completed deliveries cannot be deleted.')

    // Null out delivery_id on linked tasks so they're not orphaned.
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    await supabaseAdmin
      .from('tasks')
      .update({ delivery_id: null, updated_at: new Date().toISOString() })
      .eq('delivery_id', deliveryId)

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .delete()
      .eq('id', deliveryId)
    if (error) throw new Error(error.message)

    revalidatePath('/trackers')
  }, {
    action_type: 'delete',
    table_name: 'service_deliveries',
    record_id: deliveryId,
    summary: 'Service delivery deleted',
  })
}
