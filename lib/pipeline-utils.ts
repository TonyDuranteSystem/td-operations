/**
 * Shared pipeline utilities for Company Formation workflow.
 *
 * markFaxAsSent() consolidates the fax confirmation logic used by:
 * - /api/cron/faxage-ss4-confirm (automated FaxAge email parsing)
 * - /api/crm/admin-actions/contact-actions (manual CRM "Mark Fax as Sent" button)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Types ─────────────────────────────────────────────────────────────────

interface DeliveryRecord {
  id: string
  service_name: string
  service_type: string
  stage: string
  stage_order: number
  stage_history: unknown
  deal_id: string | null
  account_id: string
}

interface MarkFaxResult {
  success: boolean
  detail: string
  side_effects: string[]
}

// ─── advanceToEinSubmitted ─────────────────────────────────────────────────

export async function advanceToEinSubmitted(
  delivery: DeliveryRecord,
  actor: string = 'system',
  notes?: string,
): Promise<{ advanced: boolean; detail: string }> {
  const { data: stages } = await supabaseAdmin
    .from('pipeline_stages')
    .select('*')
    .eq('service_type', 'Company Formation')
    .order('stage_order')

  if (!stages?.length) {
    return { advanced: false, detail: 'No pipeline stages found for Company Formation' }
  }

  const targetStage = stages.find(
    (s: { stage_name: string }) => s.stage_name.toLowerCase() === 'ein submitted',
  )
  if (!targetStage) {
    return { advanced: false, detail: 'Stage "EIN Submitted" not found in pipeline' }
  }

  // [diag] temporary — faxage Oh My Creatives duplicate-task investigation 2026-04-17
  console.warn('[diag:advanceToEinSubmitted:guard55]', {
    sd_id: delivery.id,
    delivery_stage: delivery.stage,
    delivery_stage_order: delivery.stage_order,
    stage_history_length: Array.isArray(delivery.stage_history) ? (delivery.stage_history as unknown[]).length : null,
    target_stage: targetStage.stage_name,
    target_order: targetStage.stage_order,
    actor,
  })

  // Don't advance backwards
  if ((delivery.stage_order || 0) >= targetStage.stage_order) {
    return {
      advanced: false,
      detail: `Already at "${delivery.stage}" (order ${delivery.stage_order}), skipping`,
    }
  }

  const historyEntry = {
    from_stage: delivery.stage || 'New',
    from_order: delivery.stage_order || 0,
    to_stage: targetStage.stage_name,
    to_order: targetStage.stage_order,
    advanced_at: new Date().toISOString(),
    notes: notes || `Advanced by ${actor}`,
  }
  const stageHistory = Array.isArray(delivery.stage_history)
    ? [...delivery.stage_history, historyEntry]
    : [historyEntry]

  // eslint-disable-next-line no-restricted-syntax
  await supabaseAdmin
    .from('service_deliveries')
    .update({
      stage: targetStage.stage_name,
      stage_order: targetStage.stage_order,
      stage_entered_at: new Date().toISOString(),
      stage_history: stageHistory,
      updated_at: new Date().toISOString(),
    })
    .eq('id', delivery.id)

  // Create auto-tasks for EIN Submitted stage
  if (targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
    for (const taskDef of targetStage.auto_tasks as Array<{
      title: string
      assigned_to?: string
      category?: string
      priority?: string
      description?: string
    }>) {
      // eslint-disable-next-line no-restricted-syntax
      await supabaseAdmin.from('tasks').insert({
        task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
        assigned_to: taskDef.assigned_to || 'Luca',
        category: (taskDef.category || 'Internal') as never,
        priority: (taskDef.priority || 'Normal') as never,
        description: taskDef.description || `Auto-created: Pipeline advanced to EIN Submitted by ${actor}.`,
        status: 'To Do',
        account_id: delivery.account_id,
        deal_id: delivery.deal_id,
        delivery_id: delivery.id,
        stage_order: targetStage.stage_order,
      })
    }
  }

  // Log the advance
  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'advance',
    table_name: 'service_deliveries',
    record_id: delivery.id,
    account_id: delivery.account_id,
    summary: `Pipeline advanced: ${delivery.stage || 'New'} -> EIN Submitted (by ${actor})`,
    details: {
      from_stage: delivery.stage,
      to_stage: targetStage.stage_name,
      to_order: targetStage.stage_order,
    },
  })

  return { advanced: true, detail: `Advanced to EIN Submitted` }
}

// ─── markFaxAsSent ─────────────────────────────────────────────────────────

export async function markFaxAsSent(
  ss4Id: string,
  actor: string = 'system',
  notes?: string,
): Promise<MarkFaxResult> {
  const side_effects: string[] = []

  // 1. Validate and update SS-4 status
  const { data: ss4 } = await supabaseAdmin
    .from('ss4_applications')
    .select('id, account_id, company_name, status, token')
    .eq('id', ss4Id)
    .single()

  if (!ss4) {
    return { success: false, detail: 'SS-4 not found', side_effects }
  }
  // [diag] temporary — faxage Oh My Creatives duplicate-task investigation 2026-04-17
  console.warn('[diag:markFaxAsSent:guard146]', {
    ss4_id: ss4.id,
    ss4_status: ss4.status,
    ss4_company: ss4.company_name,
    actor,
    notes,
  })
  if (ss4.status === 'submitted') {
    return { success: false, detail: 'SS-4 already marked as submitted', side_effects }
  }

  await supabaseAdmin
    .from('ss4_applications')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('id', ss4.id)
  side_effects.push(`SS-4 status → submitted`)

  // 2. Find active Company Formation SD for this account
  if (ss4.account_id) {
    const { data: deliveries } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_name, service_type, stage, stage_order, stage_history, deal_id, account_id')
      .eq('account_id', ss4.account_id)
      .eq('service_type', 'Company Formation')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)

    if (deliveries && deliveries.length > 0) {
      const result = await advanceToEinSubmitted(deliveries[0], actor, notes)
      if (result.advanced) {
        side_effects.push(`Pipeline advanced to EIN Submitted`)
        side_effects.push(`Auto-tasks created for EIN Submitted stage`)
      } else {
        side_effects.push(`Pipeline not advanced: ${result.detail}`)
      }
    } else {
      side_effects.push('No active Company Formation delivery found')
    }

    // 3. Close open fax tasks
    const { updateTasksBulk } = await import('@/lib/operations/task')
    const closeResult = await updateTasksBulk({
      account_id: ss4.account_id,
      title_ilike: '%Fax%SS-4%',
      status_in: ['To Do', 'In Progress', 'Waiting'],
      patch: { status: 'Done' },
      actor: 'system:ss4-fax-confirmed',
      summary: 'Auto-closed SS-4 fax tasks after fax confirmation',
    })
    if (closeResult.count && closeResult.count > 0) {
      side_effects.push(`${closeResult.count} fax task(s) marked Done`)
    }
  }

  // 4. Log to action_log
  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'ss4_fax_confirmed',
    table_name: 'ss4_applications',
    record_id: ss4.id,
    account_id: ss4.account_id,
    summary: `SS-4 fax marked as sent for ${ss4.company_name} (by ${actor})`,
    details: { notes },
  })
  side_effects.push(`Logged ss4_fax_confirmed action`)

  return {
    success: true,
    detail: `Fax marked as sent for ${ss4.company_name}. Pipeline advanced to EIN Submitted.`,
    side_effects,
  }
}

// ─── advanceFormationToStage ───────────────────────────────────────────────

export async function advanceFormationToStage(
  deliveryId: string,
  targetStageName: string,
  actor: string = 'system',
  notes?: string,
): Promise<{ advanced: boolean; detail: string; sideEffects: string[] }> {
  const sideEffects: string[] = []

  const { data: delivery } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_name, service_type, stage, stage_order, stage_history, deal_id, account_id')
    .eq('id', deliveryId)
    .single()

  if (!delivery) {
    return { advanced: false, detail: 'Service delivery not found', sideEffects }
  }

  const { data: stages } = await supabaseAdmin
    .from('pipeline_stages')
    .select('*')
    .eq('service_type', delivery.service_type)
    .order('stage_order')

  if (!stages?.length) {
    return { advanced: false, detail: `No pipeline stages for ${delivery.service_type}`, sideEffects }
  }

  const targetStage = stages.find(
    (s: { stage_name: string }) => s.stage_name.toLowerCase() === targetStageName.toLowerCase(),
  )
  if (!targetStage) {
    return { advanced: false, detail: `Stage "${targetStageName}" not found`, sideEffects }
  }

  if ((delivery.stage_order || 0) >= targetStage.stage_order) {
    return { advanced: false, detail: `Already at "${delivery.stage}" (order ${delivery.stage_order})`, sideEffects }
  }

  const historyEntry = {
    from_stage: delivery.stage || 'New',
    from_order: delivery.stage_order || 0,
    to_stage: targetStage.stage_name,
    to_order: targetStage.stage_order,
    advanced_at: new Date().toISOString(),
    notes: notes || `Advanced by ${actor}`,
  }
  const stageHistory = Array.isArray(delivery.stage_history)
    ? [...delivery.stage_history, historyEntry]
    : [historyEntry]

  // eslint-disable-next-line no-restricted-syntax
  await supabaseAdmin
    .from('service_deliveries')
    .update({
      stage: targetStage.stage_name,
      stage_order: targetStage.stage_order,
      stage_entered_at: new Date().toISOString(),
      stage_history: stageHistory,
      updated_at: new Date().toISOString(),
    })
    .eq('id', delivery.id)

  sideEffects.push(`Stage: ${delivery.stage} -> ${targetStage.stage_name}`)

  // Create auto-tasks
  if (targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
    let created = 0
    for (const taskDef of targetStage.auto_tasks as Array<{
      title: string; assigned_to?: string; category?: string; priority?: string; description?: string
    }>) {
      // eslint-disable-next-line no-restricted-syntax
      const { error: tErr } = await supabaseAdmin.from('tasks').insert({
        task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
        assigned_to: taskDef.assigned_to || 'Luca',
        category: (taskDef.category || 'Internal') as never,
        priority: (taskDef.priority || 'Normal') as never,
        description: taskDef.description || `Auto-created: Pipeline advanced to "${targetStage.stage_name}" by ${actor}.`,
        status: 'To Do',
        account_id: delivery.account_id,
        deal_id: delivery.deal_id,
        delivery_id: delivery.id,
        stage_order: targetStage.stage_order,
      })
      if (!tErr) created++
    }
    if (created > 0) sideEffects.push(`${created} auto-tasks created`)
  }

  // Log
  await supabaseAdmin.from('action_log').insert({
    actor,
    action_type: 'advance',
    table_name: 'service_deliveries',
    record_id: delivery.id,
    account_id: delivery.account_id,
    summary: `Pipeline advanced: ${delivery.stage || 'New'} -> ${targetStage.stage_name} (by ${actor})`,
    details: { from_stage: delivery.stage, to_stage: targetStage.stage_name, notes },
  })

  return { advanced: true, detail: `Advanced to ${targetStage.stage_name}`, sideEffects }
}
