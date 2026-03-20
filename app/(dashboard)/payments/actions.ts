'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createPaymentSchema, updatePaymentSchema, type CreatePaymentInput, type UpdatePaymentInput } from '@/lib/schemas/payment'

export async function markPaymentPaid(paymentId: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const today = new Date().toISOString().split('T')[0]
    const updates = {
      status: 'Paid',
      paid_date: today,
    }

    if (updatedAt) {
      const result = await updateWithLock('payments', paymentId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase
        .from('payments')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', paymentId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/payments')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'payments', record_id: paymentId,
    summary: 'Status → Paid', details: { status: 'Paid' },
  })
}

export async function updatePaymentStatus(paymentId: string, status: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const updates: Record<string, unknown> = { status }
    if (status === 'Paid') {
      updates.paid_date = new Date().toISOString().split('T')[0]
    }

    if (updatedAt) {
      const result = await updateWithLock('payments', paymentId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      const { error } = await supabase
        .from('payments')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', paymentId)
      if (error) throw new Error(error.message)
    }
    revalidatePath('/payments')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'payments', record_id: paymentId,
    summary: `Status → ${status}`, details: { status },
  })
}

export async function createPayment(input: CreatePaymentInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createPaymentSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('payments')
      .insert({ ...parsed.data, created_at: now, updated_at: now })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/payments')
    revalidatePath('/accounts')
    return data
  }, {
    action_type: 'create', table_name: 'payments', account_id: parsed.data?.account_id,
    summary: `Created: ${parsed.data.description}`,
    details: { ...parsed.data },
  })
}

export async function updatePayment(input: UpdatePaymentInput): Promise<ActionResult> {
  const parsed = updatePaymentSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { id, updated_at, ...updates } = parsed.data

  return safeAction(async () => {
    const result = await updateWithLock('payments', id, updates, updated_at)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/payments')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'payments', record_id: id,
    summary: `Updated: ${Object.keys(updates).join(', ')}`,
    details: updates,
  })
}

export async function addPaymentNote(paymentId: string, note: string, updatedAt: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    // Fetch current notes
    const { data: current, error: fetchErr } = await supabase
      .from('payments')
      .select('notes')
      .eq('id', paymentId)
      .single()
    if (fetchErr) throw new Error(fetchErr.message)

    const today = new Date().toISOString().split('T')[0]
    const newNote = `[${today}] ${note}`
    const combined = current?.notes ? `${newNote}\n${current.notes}` : newNote

    const result = await updateWithLock('payments', paymentId, { notes: combined }, updatedAt)
    if (!result.success) throw new Error(result.error)
    revalidatePath('/payments')
    revalidatePath('/accounts')
  }, {
    action_type: 'update', table_name: 'payments', record_id: paymentId,
    summary: `Added note`, details: { note },
  })
}
