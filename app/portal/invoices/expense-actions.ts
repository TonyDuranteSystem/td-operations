'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create a manual expense entry (client adds an invoice they received from a vendor).
 */
export async function createExpense(input: {
  account_id: string
  vendor_name: string
  vendor_id?: string
  invoice_number?: string
  description?: string
  currency: 'USD' | 'EUR'
  total: number
  issue_date?: string
  due_date?: string
  category?: string
  notes?: string
  attachment_url?: string
  attachment_name?: string
  source?: 'manual' | 'upload'
}): Promise<ActionResult<{ id: string }>> {
  return safeAction(async () => {
    // Generate internal reference
    const { data: lastExp } = await supabaseAdmin
      .from('client_expenses')
      .select('internal_ref')
      .like('internal_ref', 'EXP-%')
      .order('internal_ref', { ascending: false })
      .limit(1)

    let expSeq = 1
    if (lastExp && lastExp.length > 0) {
      const lastNum = lastExp[0].internal_ref?.replace('EXP-', '') || '0'
      const parsed = parseInt(lastNum, 10)
      if (!isNaN(parsed)) expSeq = parsed + 1
    }
    const internalRef = `EXP-${String(expSeq).padStart(6, '0')}`

    const { data, error } = await supabaseAdmin
      .from('client_expenses')
      .insert({
        account_id: input.account_id,
        vendor_name: input.vendor_name,
        invoice_number: input.invoice_number || null,
        internal_ref: internalRef,
        description: input.description || null,
        currency: input.currency,
        subtotal: input.total,
        total: input.total,
        issue_date: input.issue_date || new Date().toISOString().split('T')[0],
        due_date: input.due_date || null,
        status: 'Pending',
        source: input.source || 'manual',
        category: input.category || 'General',
        notes: input.notes || null,
        vendor_id: input.vendor_id || null,
        attachment_url: input.attachment_url || null,
        attachment_name: input.attachment_name || null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
    return data
  }, {
    action_type: 'create', table_name: 'client_expenses', account_id: input.account_id,
    summary: `Expense created: ${input.vendor_name} — ${input.currency} ${input.total}`,
  })
}

/**
 * Update an expense (only for manual/upload sources).
 */
export async function updateExpense(
  expenseId: string,
  updates: {
    vendor_name?: string
    invoice_number?: string
    description?: string
    total?: number
    due_date?: string | null
    category?: string
    notes?: string
  }
): Promise<ActionResult> {
  return safeAction(async () => {
    // Verify it's not a TD invoice (those can't be edited by client)
    const { data: exp } = await supabaseAdmin
      .from('client_expenses')
      .select('source')
      .eq('id', expenseId)
      .single()
    if (!exp) throw new Error('Expense not found')
    if (exp.source === 'td_invoice') throw new Error('Cannot edit TD invoices')

    const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (updates.vendor_name !== undefined) updateData.vendor_name = updates.vendor_name
    if (updates.invoice_number !== undefined) updateData.invoice_number = updates.invoice_number
    if (updates.description !== undefined) updateData.description = updates.description
    if (updates.total !== undefined) {
      updateData.total = updates.total
      updateData.subtotal = updates.total
    }
    if (updates.due_date !== undefined) updateData.due_date = updates.due_date
    if (updates.category !== undefined) updateData.category = updates.category
    if (updates.notes !== undefined) updateData.notes = updates.notes

    const { error } = await supabaseAdmin
      .from('client_expenses')
      .update(updateData)
      .eq('id', expenseId)
    if (error) throw new Error(error.message)

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_expenses', record_id: expenseId,
    summary: 'Expense updated',
  })
}

/**
 * Mark an expense as paid.
 */
export async function markExpensePaid(expenseId: string, paidDate?: string): Promise<ActionResult> {
  return safeAction(async () => {
    await supabaseAdmin
      .from('client_expenses')
      .update({
        status: 'Paid',
        paid_date: paidDate || new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      })
      .eq('id', expenseId)

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_expenses', record_id: expenseId,
    summary: 'Expense marked as paid',
  })
}

/**
 * Delete an expense (only manual/upload — NOT td_invoice).
 */
export async function deleteExpense(expenseId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { data: exp } = await supabaseAdmin
      .from('client_expenses')
      .select('source')
      .eq('id', expenseId)
      .single()
    if (!exp) throw new Error('Expense not found')
    if (exp.source === 'td_invoice') throw new Error('Cannot delete TD invoices')

    const { error } = await supabaseAdmin
      .from('client_expenses')
      .delete()
      .eq('id', expenseId)
    if (error) throw new Error(error.message)

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'delete', table_name: 'client_expenses', record_id: expenseId,
    summary: 'Expense deleted',
  })
}
