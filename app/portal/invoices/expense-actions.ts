'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { getClientContactId } from '@/lib/portal-auth'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { listVendors, createVendor } from './vendor-actions'

/**
 * Find an existing vendor matching `name` (trimmed, case-insensitive — never
 * a database LIKE/ILIKE match, which would treat `%`/`_` in a typed name as
 * wildcards and could silently attach the expense to the WRONG vendor) or
 * create a new one. Fail-open: any lookup/create error is swallowed and
 * returns null — a client-recorded expense must never fail to save just
 * because the vendor-linking enrichment step had trouble. dev job 06e57270:
 * previously a typed vendor name was NEVER linked to a real vendor record at
 * all, so it never appeared in the client's own Suppliers list.
 */
async function resolveOrCreateVendorId(accountId: string, name: string): Promise<string | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  try {
    const existing = await listVendors(accountId)
    const match = existing.find(v => v.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (match) return match.id

    const res = await createVendor({ account_id: accountId, name: trimmed })
    return res.success && res.data ? res.data.id : null
  } catch {
    return null
  }
}

/**
 * Verify the logged-in caller owns the expense being touched, before any
 * update/mark-paid/delete. Same dual-check shape already proven for portal
 * documents (app/api/portal/documents/[id]/route.ts): account-scoped rows go
 * through canAccessAccount (capability-gated); contact-scoped rows (no
 * account_id — formation-gap clients) match only the exact owning contact,
 * never a teammate. Throws (safeAction turns it into a clean ActionResult)
 * rather than returning a boolean, since every caller must stop on failure.
 */
async function assertOwnsExpense(exp: { account_id: string | null; contact_id: string | null }): Promise<void> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthorized')

  const hasAccountAccess = exp.account_id ? await canAccessAccount(user, exp.account_id, 'invoices_billing') : false
  const contactId = getClientContactId(user)
  const hasContactAccess = !exp.account_id && !!contactId && exp.contact_id === contactId
  if (!hasAccountAccess && !hasContactAccess) throw new Error('Access denied')
}

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
  attachment_storage_path?: string
  attachment_name?: string
  source?: 'manual' | 'upload'
}): Promise<ActionResult<{ id: string }>> {
  return safeAction(async () => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Unauthorized')
    if (!(await canAccessAccount(user, input.account_id, 'invoices_billing'))) {
      throw new Error('Access denied')
    }

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

    // Find-or-create the matching vendor so it shows up in the client's own
    // Suppliers list — previously a typed name was never linked to a real
    // vendor record at all (dev job 06e57270). Best-effort: never blocks the
    // expense from saving if this step has trouble.
    const vendorId = input.vendor_id || await resolveOrCreateVendorId(input.account_id, input.vendor_name)

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
        vendor_id: vendorId,
        // attachment_url is intentionally NOT written here — it's resolved fresh
        // (a short-lived signed link) at read time in getPortalExpenses/
        // getPortalExpensesByContact from attachment_storage_path. A null value
        // here does NOT mean "no attachment" — check attachment_storage_path.
        attachment_storage_path: input.attachment_storage_path || null,
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
    const { data: exp } = await supabaseAdmin
      .from('client_expenses')
      .select('source, account_id, contact_id')
      .eq('id', expenseId)
      .single()
    if (!exp) throw new Error('Expense not found')
    await assertOwnsExpense(exp)
    // Verify it's not a TD invoice (those can't be edited by client)
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
    const { data: exp } = await supabaseAdmin
      .from('client_expenses')
      .select('source, account_id, contact_id')
      .eq('id', expenseId)
      .single()
    if (!exp) throw new Error('Expense not found')
    await assertOwnsExpense(exp)
    // Verify it's not a TD invoice (those settle only through the real
    // invoice being paid — never a direct client-side edit of the mirror;
    // matches the same guard on updateExpense/deleteExpense above, and is
    // now also enforced at the database layer, dev job 0dcb0a18).
    if (exp.source === 'td_invoice') throw new Error('Cannot mark a TD invoice paid directly')

    const { error } = await supabaseAdmin
      .from('client_expenses')
      .update({
        status: 'Paid',
        paid_date: paidDate || new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      })
      .eq('id', expenseId)
    if (error) throw new Error(error.message)

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
      .select('source, account_id, contact_id')
      .eq('id', expenseId)
      .single()
    if (!exp) throw new Error('Expense not found')
    await assertOwnsExpense(exp)
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
