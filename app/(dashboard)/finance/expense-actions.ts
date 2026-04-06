'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

export async function createTDExpense(input: {
  vendor_name: string
  invoice_number?: string
  description?: string
  currency: 'USD' | 'EUR'
  total: number
  issue_date?: string
  due_date?: string
  category?: string
  payment_method?: string
  notes?: string
  account_id?: string
  mark_as_paid?: boolean
}): Promise<ActionResult<{ id: string }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabaseAdmin
      .from('td_expenses')
      .insert({
        vendor_name: input.vendor_name,
        invoice_number: input.invoice_number || null,
        description: input.description || null,
        currency: input.currency,
        subtotal: input.total,
        total: input.total,
        issue_date: input.issue_date || today,
        due_date: input.due_date || null,
        paid_date: input.mark_as_paid ? today : null,
        status: input.mark_as_paid ? 'Paid' : 'Pending',
        payment_method: input.payment_method || null,
        category: input.category || 'Operations',
        account_id: input.account_id || null,
        notes: input.notes || null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    revalidatePath('/finance')
    return data
  }, {
    action_type: 'create', table_name: 'td_expenses',
    summary: `TD expense created: ${input.vendor_name} — ${input.currency} ${input.total}`,
  })
}

export async function markTDExpensePaid(
  expenseId: string,
  paymentMethod?: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    await supabaseAdmin
      .from('td_expenses')
      .update({
        status: 'Paid',
        paid_date: new Date().toISOString().split('T')[0],
        payment_method: paymentMethod || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', expenseId)
    revalidatePath('/finance')
  }, {
    action_type: 'update', table_name: 'td_expenses', record_id: expenseId,
    summary: 'TD expense marked as paid',
  })
}

export async function voidTDExpense(expenseId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    await supabaseAdmin
      .from('td_expenses')
      .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
      .eq('id', expenseId)
    revalidatePath('/finance')
  }, {
    action_type: 'update', table_name: 'td_expenses', record_id: expenseId,
    summary: 'TD expense voided',
  })
}

export async function updateTDExpense(
  expenseId: string,
  updates: {
    vendor_name?: string
    invoice_number?: string
    description?: string
    total?: number
    due_date?: string | null
    category?: string
    notes?: string
    payment_method?: string
  }
): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (updates.vendor_name !== undefined) updateData.vendor_name = updates.vendor_name
    if (updates.invoice_number !== undefined) updateData.invoice_number = updates.invoice_number
    if (updates.description !== undefined) updateData.description = updates.description
    if (updates.total !== undefined) { updateData.total = updates.total; updateData.subtotal = updates.total }
    if (updates.due_date !== undefined) updateData.due_date = updates.due_date
    if (updates.category !== undefined) updateData.category = updates.category
    if (updates.notes !== undefined) updateData.notes = updates.notes
    if (updates.payment_method !== undefined) updateData.payment_method = updates.payment_method

    const { error } = await supabaseAdmin.from('td_expenses').update(updateData).eq('id', expenseId)
    if (error) throw new Error(error.message)
    revalidatePath('/finance')
  }, {
    action_type: 'update', table_name: 'td_expenses', record_id: expenseId,
    summary: `TD expense updated: ${Object.keys(updates).join(', ')}`,
  })
}

export async function deleteTDExpense(expenseId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { error } = await supabaseAdmin.from('td_expenses').delete().eq('id', expenseId)
    if (error) throw new Error(error.message)
    revalidatePath('/finance')
  }, {
    action_type: 'delete', table_name: 'td_expenses', record_id: expenseId,
    summary: 'TD expense deleted',
  })
}
