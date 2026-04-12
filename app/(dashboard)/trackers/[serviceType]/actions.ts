'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { advanceServiceDelivery } from '@/lib/service-delivery'

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

  try {
    const result = await advanceServiceDelivery({
      delivery_id: deliveryId,
      target_stage: 'Completed',
      actor: 'crm-tracker',
    })

    revalidatePath('/trackers')
    return {
      success: result.success,
      error: result.error,
      auto_triggers: result.auto_triggers,
    }
  } catch (err) {
    // Fallback: if "Completed" stage doesn't exist in pipeline_stages, just mark complete directly
    const { error } = await supabaseAdmin
      .from('service_deliveries')
      .update({
        status: 'completed',
        end_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      })
      .eq('id', deliveryId)

    if (error) return { success: false, error: error.message }
    revalidatePath('/trackers')
    return { success: true }
  }
}
