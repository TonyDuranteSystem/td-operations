'use server'

/**
 * confirmItinMailed advances the contact's ITIN flow when the client confirms
 * they've mailed their signed documents:
 *   - Workflow path (Slice 5+): finds the active itin_await_client_mailing
 *     workflow task for the contact, marks it Done, fires the catalog
 *     transition (spawns itin_caa_certify_and_mail + advances SD to
 *     Documents Received). This is the system of record going forward.
 *   - Legacy fallback: contacts with an ITIN started before Slice 5 won't
 *     have an itin_await_client_mailing task. We fall through to a direct
 *     SD advance (the pre-Slice-5 behavior) so they don't get stuck.
 *
 * Authorization: the SD and / or task must belong to the authenticated
 * portal contact. Both paths verify ownership before mutating.
 *
 * Moved out of the (now-removed) standalone /portal/itin-documents page into
 * this page-agnostic module — components/portal/itin-shipping-form.tsx (the
 * live confirmation flow embedded in the /portal/flows/[id] workspace) is
 * the real caller; the standalone page was a pre-workspace duplicate.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { advanceServiceDelivery } from '@/lib/service-delivery'
import { createWorkflowTask, updateTask } from '@/lib/operations/task'
import { getWorkflowCatalogRow, resolveCatalogTransition } from '@/lib/tasks/chain-transitions'
import type { TaskRow } from '@/lib/tasks/types'
import { revalidatePath } from 'next/cache'

export interface ConfirmItinMailedResult {
  success: boolean
  error?: string
  /** 'workflow' = ran the new chain. 'legacy' = direct SD advance fallback. */
  path?: 'workflow' | 'legacy'
}

export async function confirmItinMailed(): Promise<ConfirmItinMailedResult> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Unauthorized' }

  const contactId = getClientContactId(user)
  if (!contactId) return { success: false, error: 'No contact linked to this user.' }

  // ── Workflow path: find the active itin_await_client_mailing task ────
  // Cast 'as never' on the eq() column for now — workflow_slug isn't in
  // lib/database.types.ts until Slice 14's gen:types regen.
  const { data: awaitingTask } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .eq('workflow_slug' as never, 'itin_await_client_mailing')
    .eq('contact_id', contactId)
    .neq('status', 'Done')
    .neq('status', 'Cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (awaitingTask) {
    return await runWorkflowMailedAction(awaitingTask as unknown as TaskRow)
  }

  // ── Legacy fallback ──────────────────────────────────────────────────
  return await runLegacyMailedAction(contactId)
}

async function runWorkflowMailedAction(task: TaskRow): Promise<ConfirmItinMailedResult> {
  // 1. Close the awaiting-client-mailing task. Stamp task_meta to match the
  //    catalog's on_success_meta (workflow_state: 'Client mailed'). We don't
  //    go through the dispatcher route because that requires staff auth;
  //    the client-side equivalent is this server action.
  const baseMeta = (task.task_meta ?? {}) as Record<string, unknown>
  const { last_error: _drop, ...metaNoError } = baseMeta as { last_error?: unknown }
  const taskUpdate = await updateTask({
    id: task.id,
    patch: {
      status: 'Done',
      task_meta: {
        ...metaNoError,
        workflow_state: 'Client mailed',
        client_mailed_at: new Date().toISOString(),
      },
    } as Parameters<typeof updateTask>[0]['patch'],
    actor: 'portal-client:confirmItinMailed',
    summary: 'Client confirmed mailing via portal',
    details: { workflow_slug: task.workflow_slug, action_slug: 'client_mailed' },
  })
  if (!taskUpdate.success) {
    return { success: false, error: taskUpdate.error ?? 'Failed to close awaiting task', path: 'workflow' }
  }

  // 2. Catalog transition resolver: should give us spawn_workflow +
  //    advance_sd_stage per the seeded transitions.
  const transition = await resolveCatalogTransition({
    task,
    workflowSlug: 'itin_await_client_mailing',
    transitionKey: 'client_mailed',
  })

  // 3. Spawn the next workflow task (itin_caa_certify_and_mail).
  if (transition?.spawn_workflow) {
    const nextSnapshot = await getWorkflowCatalogRow(transition.spawn_workflow)
    if (nextSnapshot) {
      const inheritedMeta: Record<string, unknown> = {
        ...metaNoError,
        workflow_state: 'Awaiting receipt',
        spawned_from_task_id: task.id,
        spawned_via: 'catalog_transition:portal_client_mailed',
        spawned_at: new Date().toISOString(),
      }
      const firstName =
        typeof inheritedMeta.client_first_name === 'string' ? inheritedMeta.client_first_name : ''
      const lastName =
        typeof inheritedMeta.client_last_name === 'string' ? inheritedMeta.client_last_name : ''
      const clientName = `${firstName} ${lastName}`.trim()
      const labelAdmin =
        typeof nextSnapshot.label_admin === 'string' ? nextSnapshot.label_admin : 'CAA certify + mail to IRS'
      const defaultAssignee =
        typeof nextSnapshot.default_assignee === 'string' ? nextSnapshot.default_assignee : task.assigned_to

      const spawn = await createWorkflowTask({
        workflow_slug: transition.spawn_workflow,
        workflow_snapshot: nextSnapshot,
        task_meta: inheritedMeta,
        task_title: clientName ? `${labelAdmin} — ${clientName}` : labelAdmin,
        assigned_to: defaultAssignee,
        account_id: task.account_id,
        deal_id: task.deal_id,
        service_id: task.service_id,
        delivery_id: task.delivery_id,
        contact_id: task.contact_id,
        actor: 'portal-client:confirmItinMailed',
        summary: `Spawned by client_mailed (catalog transition)`,
        details: {
          parent_task_id: task.id,
          workflow_slug: transition.spawn_workflow,
          mode: 'catalog_transition',
          transition_key: 'client_mailed',
        },
      })
      if (!spawn.success) {
        console.warn('[confirmItinMailed] spawn next workflow failed:', spawn.error)
      }
    } else {
      console.warn(
        `[confirmItinMailed] catalog transition wants spawn_workflow='${transition.spawn_workflow}' but no task_workflows catalog row found`,
      )
    }
  }

  // 4. Advance the SD per the catalog transition.
  if (transition?.advance_sd_stage && task.delivery_id) {
    const adv = await advanceServiceDelivery({
      delivery_id: task.delivery_id,
      target_stage: transition.advance_sd_stage,
      actor: 'portal-client:confirmItinMailed',
      notes: 'Client confirmed via portal that signed documents were mailed.',
    })
    if (!adv.success) {
      console.warn('[confirmItinMailed] SD advance failed:', adv.error)
    }
  }

  revalidatePath('/portal')
  return { success: true, path: 'workflow' }
}

async function runLegacyMailedAction(contactId: string): Promise<ConfirmItinMailedResult> {
  // Pre-Slice-5 contacts have no itin_await_client_mailing task. Fall back
  // to the original direct-SD-advance behavior so they don't get stuck.
  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, stage, status')
    .eq('contact_id', contactId)
    .eq('service_type', 'ITIN')
    .eq('stage', 'Client Signing')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!sd) {
    return { success: false, error: 'No active ITIN service found at Client Signing stage.', path: 'legacy' }
  }

  const result = await advanceServiceDelivery({
    delivery_id: sd.id,
    target_stage: 'Documents Received',
    actor: 'portal-client',
    notes: 'Client confirmed via portal that signed documents were mailed (legacy path — no workflow task).',
  })

  if (!result.success) {
    return { success: false, error: result.error || 'Failed to advance ITIN service.', path: 'legacy' }
  }

  revalidatePath('/portal')
  return { success: true, path: 'legacy' }
}
