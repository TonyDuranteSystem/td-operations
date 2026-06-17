/**
 * Shared pipeline utilities for Company Formation workflow.
 *
 * markFaxAsSent() consolidates the fax confirmation logic used by:
 * - /api/cron/faxage-ss4-confirm (automated FaxAge email parsing)
 * - /api/crm/admin-actions/contact-actions (manual CRM "Mark Fax as Sent" button)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Types ─────────────────────────────────────────────────────────────────

interface MarkFaxResult {
  success: boolean
  detail: string
  side_effects: string[]
}

// ─── markFaxAsSent ─────────────────────────────────────────────────────────

export async function markFaxAsSent(
  ss4Id: string,
  actor: string = 'system',
  notes?: string,
  extraDetails?: Record<string, unknown>,
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
  if (ss4.status === 'submitted') {
    return { success: false, detail: 'SS-4 already marked as submitted', side_effects }
  }

  await supabaseAdmin
    .from('ss4_applications')
    .update({ status: 'submitted', updated_at: new Date().toISOString() })
    .eq('id', ss4.id)
  side_effects.push(`SS-4 status → submitted`)

  // 2. Faxing the SS-4 no longer auto-advances the SD. In the 8-stage Company
  // Formation pipeline the SD stays at "SS-4 Signed" (where the fax tool lives)
  // and staff manually advance to "EIN Received" once the EIN arrives from the
  // IRS. We only update the SS-4 record + close the fax tasks here.
  if (ss4.account_id) {
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
    details: { notes, ...extraDetails },
  })
  side_effects.push(`Logged ss4_fax_confirmed action`)

  return {
    success: true,
    detail: `Fax marked as sent for ${ss4.company_name}.`,
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

  // Create auto-tasks (deduplication: skip if open task with same title already exists)
  if (targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
    let created = 0
    for (const taskDef of targetStage.auto_tasks as Array<{
      title: string; assigned_to?: string; category?: string; priority?: string; description?: string
    }>) {
      const fullTitle = `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`
      const { data: existingTask } = await supabaseAdmin
        .from('tasks')
        .select('id')
        .eq('delivery_id', delivery.id)
        .eq('task_title', fullTitle)
        .in('status', ['To Do', 'In Progress', 'Waiting'])
        .limit(1)
      if (existingTask && existingTask.length > 0) continue
      // eslint-disable-next-line no-restricted-syntax
      const { error: tErr } = await supabaseAdmin.from('tasks').insert({
        task_title: fullTitle,
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
