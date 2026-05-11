'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { advanceServiceDelivery } from '@/lib/service-delivery'

export interface AdvanceSDStageResult {
  success: boolean
  error?: string
  from_stage?: string
  to_stage?: string
  is_completed?: boolean
  auto_triggers?: string[]
  created_tasks?: string[]
}

/**
 * Advance one service delivery to its next pipeline stage from the CRM
 * account/contact detail page.
 *
 * Routes through advanceServiceDelivery (NOT a raw service_deliveries.update)
 * so every advance fires the same side-effects as the MCP sd_advance_stage
 * tool: stage_history append, auto-tasks, portal tier upgrade, client
 * notification, tax_return sync, RA/AR renewal dates, closure cascade,
 * action_log entry.
 *
 * Optimistic lock: caller passes the SD's updated_at as observed when the
 * page rendered. If the SD has been touched since (another tab, MCP tool,
 * cron, another staff member), we reject with a clear message instead of
 * advancing on stale state.
 */
export async function advanceSDStage(
  deliveryId: string,
  expectedUpdatedAt: string,
  targetStage?: string,
): Promise<AdvanceSDStageResult> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const { data: sd, error: sdErr } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, updated_at, status, stage, account_id, contact_id')
    .eq('id', deliveryId)
    .maybeSingle()

  if (sdErr) return { success: false, error: sdErr.message }
  if (!sd) return { success: false, error: 'Service delivery not found' }

  if (sd.updated_at !== expectedUpdatedAt) {
    return {
      success: false,
      error:
        'This service has been updated since you opened the page. Refresh and try again.',
    }
  }

  if (sd.status === 'completed') {
    return { success: false, error: 'Service is already completed.' }
  }
  if (sd.status === 'cancelled') {
    return { success: false, error: 'Service is cancelled.' }
  }
  if (sd.status === 'on_hold') {
    return {
      success: false,
      error: 'Service is on hold. Resume it before advancing.',
    }
  }

  try {
    const result = await advanceServiceDelivery({
      delivery_id: deliveryId,
      target_stage: targetStage,
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
    })

    if (sd.account_id) {
      revalidatePath(`/accounts/${sd.account_id}`)
    }
    if (sd.contact_id) {
      revalidatePath(`/contacts/${sd.contact_id}`)
    }

    return {
      success: result.success,
      error: result.error,
      from_stage: result.from_stage,
      to_stage: result.to_stage,
      is_completed: result.is_completed,
      auto_triggers: result.auto_triggers,
      created_tasks: result.created_tasks,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Advance failed',
    }
  }
}
