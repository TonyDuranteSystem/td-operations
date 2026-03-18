'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createTaskSchema, updateTaskSchema, type CreateTaskInput, type UpdateTaskInput } from '@/lib/schemas/task'

export async function updateTaskStatus(taskId: string, status: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const updates: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
    if (status === 'Done') {
      updates.completed_date = new Date().toISOString().split('T')[0]
    }

    if (updatedAt) {
      const result = await updateWithLock('tasks', taskId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      // Legacy path: no optimistic lock (backward compat with existing task-card calls)
      const { error } = await supabase.from('tasks').update(updates).eq('id', taskId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/tasks')
  }, {
    action_type: 'update', table_name: 'tasks', record_id: taskId,
    summary: `Status \u2192 ${status}`, details: { status },
  })
}

export async function updateTaskPriority(taskId: string, priority: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    if (updatedAt) {
      const result = await updateWithLock('tasks', taskId, { priority }, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase.from('tasks').update({ priority, updated_at: new Date().toISOString() }).eq('id', taskId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/tasks')
  }, {
    action_type: 'update', table_name: 'tasks', record_id: taskId,
    summary: `Priority \u2192 ${priority}`, details: { priority },
  })
}

export async function updateTaskAssignee(taskId: string, assignedTo: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    if (updatedAt) {
      const result = await updateWithLock('tasks', taskId, { assigned_to: assignedTo }, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase.from('tasks').update({ assigned_to: assignedTo, updated_at: new Date().toISOString() }).eq('id', taskId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/tasks')
  }, {
    action_type: 'update', table_name: 'tasks', record_id: taskId,
    summary: `Reassigned \u2192 ${assignedTo}`, details: { assigned_to: assignedTo },
  })
}

export async function createTask(input: CreateTaskInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createTaskSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
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

export async function updateTask(input: UpdateTaskInput): Promise<ActionResult> {
  const parsed = updateTaskSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, updated_at, ...updates } = parsed.data

  return safeAction(async () => {
    const result = await updateWithLock('tasks', id, updates, updated_at)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/tasks')
  }, {
    action_type: 'update', table_name: 'tasks', record_id: id,
    summary: `Updated: ${Object.keys(updates).join(', ')}`,
    details: updates,
  })
}
