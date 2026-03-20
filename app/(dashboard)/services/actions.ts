'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createServiceSchema, updateServiceSchema, type CreateServiceInput, type UpdateServiceInput } from '@/lib/schemas/service'

export async function updateServiceStatus(serviceId: string, newStatus: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const updates: Record<string, unknown> = {
      status: newStatus,
      stage_entered_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (newStatus !== 'Blocked') {
      updates.blocked_waiting_external = false
      updates.blocked_reason = null
      updates.blocked_since = null
    }

    if (updatedAt) {
      const result = await updateWithLock('services', serviceId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase.from('services').update(updates).eq('id', serviceId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/services')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'services', record_id: serviceId,
    summary: `Status → ${newStatus}`, details: { status: newStatus },
  })
}

export async function completeService(serviceId: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const updates: Record<string, unknown> = {
      status: 'Completed',
      end_date: new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    }

    if (updatedAt) {
      const result = await updateWithLock('services', serviceId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase.from('services').update(updates).eq('id', serviceId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/services')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'services', record_id: serviceId,
    summary: 'Status → Completed', details: { status: 'Completed' },
  })
}

export async function advanceServiceStep(serviceId: string, updatedAt: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Read current step
    const { data: svc, error: readErr } = await supabase
      .from('services')
      .select('current_step, total_steps')
      .eq('id', serviceId)
      .single()
    if (readErr) throw new Error(readErr.message)

    const currentStep = svc.current_step ?? 0
    const totalSteps = svc.total_steps ?? null
    const nextStep = currentStep + 1

    if (totalSteps !== null && nextStep > totalSteps) {
      throw new Error(`Already at max step (${totalSteps})`)
    }

    const result = await updateWithLock('services', serviceId, { current_step: nextStep }, updatedAt)
    if (!result.success) throw new Error(result.error)

    revalidatePath('/services')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'services', record_id: serviceId,
    summary: 'Advanced step', details: { action: 'advance_step' },
  })
}

export async function createService(input: CreateServiceInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createServiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('services')
      .insert({
        ...parsed.data,
        start_date: now.split('T')[0],
        stage_entered_at: now,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/services')
    revalidatePath('/accounts')
    return data
  }, {
    action_type: 'create', table_name: 'services', account_id: parsed.data?.account_id,
    summary: `Created: ${parsed.data.service_name}`,
    details: { ...parsed.data },
  })
}

export async function updateService(input: UpdateServiceInput): Promise<ActionResult> {
  const parsed = updateServiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, updated_at, ...updates } = parsed.data

  return safeAction(async () => {
    const result = await updateWithLock('services', id, updates, updated_at)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/services')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'services', record_id: id,
    summary: `Updated: ${Object.keys(updates).join(', ')}`,
    details: updates,
  })
}

export async function addServiceNote(serviceId: string, note: string, updatedAt: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Read current notes
    const { data: svc, error: readErr } = await supabase
      .from('services')
      .select('notes')
      .eq('id', serviceId)
      .single()
    if (readErr) throw new Error(readErr.message)

    const today = new Date().toISOString().split('T')[0]
    const prefix = `[${today}] ${note}`
    const newNotes = svc.notes ? `${prefix}\n${svc.notes}` : prefix

    const result = await updateWithLock('services', serviceId, { notes: newNotes }, updatedAt)
    if (!result.success) throw new Error(result.error)

    revalidatePath('/services')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'services', record_id: serviceId,
    summary: 'Added note', details: { note },
  })
}
