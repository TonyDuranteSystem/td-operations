'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { updateTask as updateTaskOp } from '@/lib/operations/task'
import { createTaskSchema, updateTaskSchema, type CreateTaskInput, type UpdateTaskInput } from '@/lib/schemas/task'

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
