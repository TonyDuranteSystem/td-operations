'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import { createPaymentSchema, updatePaymentSchema, type CreatePaymentInput, type UpdatePaymentInput } from '@/lib/schemas/payment'

export async function markPaymentPaid(paymentId: string, updatedAt?: string): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // A bare payment placeholder never has `total` set (only `amount` —
    // see createPaymentSchema); reading `total` here would write amount_paid
    // as null. `amount` is the one field this row type always has.
    const { data: payment, error: fetchErr } = await supabase
      .from('payments')
      .select('amount')
      .eq('id', paymentId)
      .single()
    if (fetchErr) throw new Error(fetchErr.message)

    const today = new Date().toISOString().split('T')[0]
    const updates = {
      status: 'Paid',
      paid_date: today,
      amount_paid: payment.amount,
      amount_due: 0,
    }

    if (updatedAt) {
      const result = await updateWithLock('payments', paymentId, updates, updatedAt)
      if (!result.success) throw new Error(result.error)
    } else {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
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
      // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
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
    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
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
