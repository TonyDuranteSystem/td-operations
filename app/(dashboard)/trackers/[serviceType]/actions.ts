'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { completeSD } from '@/lib/operations/service-delivery'
import { normalizeStageHistory, type StageHistoryEntry } from '@/lib/stage-history-helpers'

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
