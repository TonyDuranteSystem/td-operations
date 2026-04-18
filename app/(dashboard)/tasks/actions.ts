'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { updateTask as updateTaskOp } from '@/lib/operations/task'
import { createTaskSchema, updateTaskSchema, type CreateTaskInput, type UpdateTaskInput } from '@/lib/schemas/task'
import type { DryRunResult } from '@/lib/operations/destructive'

async function currentActor(): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`
}

export async function updateTaskStatus(taskId: string, status: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const actor = await currentActor()
    const result = await updateTaskOp({
      id: taskId,
      patch: { status: status as never },
      expected_updated_at: updatedAt,
      actor,
      summary: `Status \u2192 ${status}`,
      details: { status },
    })
    if (!result.success) throw new Error(result.error || 'Failed to update task status')
    revalidatePath('/tasks')
  })
}

export async function updateTaskPriority(taskId: string, priority: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const actor = await currentActor()
    const result = await updateTaskOp({
      id: taskId,
      patch: { priority: priority as never },
      expected_updated_at: updatedAt,
      actor,
      summary: `Priority \u2192 ${priority}`,
      details: { priority },
    })
    if (!result.success) throw new Error(result.error || 'Failed to update task priority')
    revalidatePath('/tasks')
  })
}

export async function updateTaskAssignee(taskId: string, assignedTo: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const actor = await currentActor()
    const result = await updateTaskOp({
      id: taskId,
      patch: { assigned_to: assignedTo },
      expected_updated_at: updatedAt,
      actor,
      summary: `Reassigned \u2192 ${assignedTo}`,
      details: { assigned_to: assignedTo },
    })
    if (!result.success) throw new Error(result.error || 'Failed to update task assignee')
    revalidatePath('/tasks')
  })
}

export async function createTask(input: CreateTaskInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createTaskSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
    // eslint-disable-next-line no-restricted-syntax -- create path, P3.4 #9 scope is updates only
    const { data, error } = await supabase
      .from('tasks')
      .insert({ ...parsed.data, created_at: now, updated_at: now })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/tasks')
    return data
  }, {
    action_type: 'create', table_name: 'tasks', account_id: parsed.data?.account_id,
    summary: `Created: ${parsed.data.task_title}`,
    details: { ...parsed.data },
  })
}

export async function getTaskLatestTimestamp(taskId: string): Promise<string | null> {
  const supabase = createClient()
  const { data } = await supabase
    .from('tasks')
    .select('updated_at')
    .eq('id', taskId)
    .single()
  return data?.updated_at ?? null
}

export async function updateTask(input: UpdateTaskInput): Promise<ActionResult> {
  const parsed = updateTaskSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, updated_at, ...updates } = parsed.data

  return safeAction(async () => {
    const actor = await currentActor()
    const result = await updateTaskOp({
      id,
      patch: updates as never,
      expected_updated_at: updated_at,
      actor,
      summary: `Updated: ${Object.keys(updates).join(', ')}`,
      details: updates,
    })
    if (!result.success) throw new Error(result.error || 'Failed to update task')
    revalidatePath('/tasks')
  })
}

// ─── P3.9 — delete task ────────────────────────────────

export async function deleteTaskPreview(
  taskId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const supabase = createClient()
    const { data: task } = await supabase
      .from('tasks')
      .select('id, task_title, status, priority, assigned_to, account_id, contact_id, delivery_id, category')
      .eq('id', taskId)
      .maybeSingle()
    if (!task) return { success: false, error: 'Task not found' }

    return {
      success: true,
      preview: {
        affected: { task: 1 },
        items: [
          {
            label: task.task_title ?? 'Untitled task',
            details: [
              task.status ?? 'no status',
              task.priority ?? 'no priority',
              task.assigned_to ? `assigned ${task.assigned_to}` : '',
              task.category ?? '',
            ].filter(Boolean),
          },
        ],
        warnings: [
          'The task is permanently removed. If it was created by a pipeline stage, it will NOT be auto-recreated.',
        ],
        record_label: task.task_title ?? taskId,
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

export async function deleteTask(taskId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabase.from('tasks').delete().eq('id', taskId)
    if (error) throw new Error(error.message)
    revalidatePath('/tasks')
  }, {
    action_type: 'delete',
    table_name: 'tasks',
    record_id: taskId,
    summary: 'Task deleted',
  })
}

export async function appendTaskNoteAction(taskId: string, note: string, updatedAt: string): Promise<ActionResult> {
  return safeAction(async () => {
    const actor = await currentActor()
    const { appendTaskNote } = await import('@/lib/operations/task')
    const result = await appendTaskNote({
      id: taskId,
      note,
      expected_updated_at: updatedAt,
      actor,
    })
    if (!result.success) throw new Error(result.error || 'Failed to append note')
    revalidatePath('/tasks')
  })
}
