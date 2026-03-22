'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'

export async function advanceDeliveryStage(
  deliveryId: string,
  targetStage: string,
  stageOrder: number,
  notes?: string,
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  // Update the delivery
  const { error } = await supabaseAdmin
    .from('service_deliveries')
    .update({
      stage: targetStage,
      stage_order: stageOrder,
      stage_entered_at: new Date().toISOString(),
      notes: notes || undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('id', deliveryId)

  if (error) return { success: false, error: error.message }

  // Create auto-tasks for the new stage
  const { data: stageData } = await supabaseAdmin
    .from('pipeline_stages')
    .select('auto_tasks')
    .eq('stage_name', targetStage)
    .limit(1)
    .maybeSingle()

  if (stageData?.auto_tasks && Array.isArray(stageData.auto_tasks)) {
    // Get account_id from delivery
    const { data: delivery } = await supabaseAdmin
      .from('service_deliveries')
      .select('account_id')
      .eq('id', deliveryId)
      .single()

    for (const task of stageData.auto_tasks) {
      await supabaseAdmin.from('tasks').insert({
        task_title: task.title,
        assigned_to: task.assigned_to || 'Luca',
        category: task.category || 'Internal',
        priority: task.priority || 'Normal',
        status: 'To Do',
        account_id: delivery?.account_id,
        delivery_id: deliveryId,
        stage_order: stageOrder,
      })
    }
  }

  revalidatePath('/trackers')
  return { success: true }
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
