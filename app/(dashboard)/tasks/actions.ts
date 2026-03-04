'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function updateTaskStatus(taskId: string, status: string) {
  const supabase = createClient()
  const updates: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }
  if (status === 'Done') {
    updates.completed_date = new Date().toISOString().split('T')[0]
  }
  const { error } = await supabase.from('tasks').update(updates).eq('id', taskId)
  if (error) throw new Error(error.message)
  revalidatePath('/tasks')
}

export async function updateTaskPriority(taskId: string, priority: string) {
  const supabase = createClient()
  const { error } = await supabase
    .from('tasks')
    .update({ priority, updated_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) throw new Error(error.message)
  revalidatePath('/tasks')
}

export async function updateTaskAssignee(taskId: string, assignedTo: string) {
  const supabase = createClient()
  const { error } = await supabase
    .from('tasks')
    .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
    .eq('id', taskId)
  if (error) throw new Error(error.message)
  revalidatePath('/tasks')
}
