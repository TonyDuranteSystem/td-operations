'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import {
  createInvoiceSchema, updateInvoiceSchema, createCustomerSchema, createTemplateSchema,
  type CreateInvoiceInput, type UpdateInvoiceInput, type CreateCustomerInput, type CreateTemplateInput,
} from '@/lib/schemas/portal-invoice'

export async function createCustomer(input: CreateCustomerInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createCustomerSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const { data, error } = await supabaseAdmin
      .from('client_customers')
      .insert(parsed.data)
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
    return data
  }, {
    action_type: 'create', table_name: 'client_customers', account_id: parsed.data.account_id,
    summary: `Customer created: ${parsed.data.name}`,
  })
}

export async function createInvoice(input: CreateInvoiceInput): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  const parsed = createInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const { items, recurring_frequency, recurring_end_date, ...invoiceData } = parsed.data
    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')

    const result = await createUnifiedInvoice({
      account_id: invoiceData.account_id || undefined,
      customer_id: invoiceData.customer_id || undefined,
      line_items: items.map(item => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: (invoiceData.currency || 'USD') as 'USD' | 'EUR',
      due_date: invoiceData.due_date || undefined,
      notes: invoiceData.notes || undefined,
      message: invoiceData.message || undefined,
      recurring_frequency: recurring_frequency || null,
      recurring_end_date: recurring_end_date || null,
    })

    revalidatePath('/portal/invoices')
    return { id: result.invoiceId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create', table_name: 'client_invoices', account_id: parsed.data.account_id,
    summary: `Invoice created`,
  })
}

export async function updateInvoice(input: UpdateInvoiceInput): Promise<ActionResult> {
  const parsed = updateInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const { id, items, ...updates } = parsed.data

    // If items provided, recalculate totals
    if (items) {
      const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
      const discount = updates.discount ?? 0
      Object.assign(updates, { subtotal, total: Math.max(subtotal - discount, 0) })

      // Replace items
      await supabaseAdmin.from('client_invoice_items').delete().eq('invoice_id', id)
      const itemRows = items.map((item, i) => ({ invoice_id: id, ...item, sort_order: i }))
      await supabaseAdmin.from('client_invoice_items').insert(itemRows)
    }

    const { error } = await supabaseAdmin
      .from('client_invoices')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw new Error(error.message)

    // Audit trail
    const { logInvoiceAudit } = await import('@/lib/portal/invoice-audit')
    logInvoiceAudit({
      invoice_id: id,
      action: 'edited',
      changed_fields: updates,
      performed_by: 'system',
    })

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: parsed.data.id,
    summary: `Invoice updated`,
  })
}

export async function markInvoiceAsPaid(invoiceId: string, paidDate: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { syncInvoiceStatus } = await import('@/lib/portal/unified-invoice')
    // Fetch invoice total to pass as amount
    const { data: inv } = await supabaseAdmin.from('client_invoices').select('total, amount_paid').eq('id', invoiceId).single()
    const remainingAmount = inv ? Number(inv.total) - (Number(inv.amount_paid) || 0) : undefined
    await syncInvoiceStatus('invoice', invoiceId, 'Paid', paidDate, remainingAmount)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: 'Invoice marked as paid',
  })
}

export async function recordPartialPayment(
  invoiceId: string,
  amountPaid: number,
  paidDate: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const { syncInvoiceStatus } = await import('@/lib/portal/unified-invoice')
    await syncInvoiceStatus('invoice', invoiceId, 'Partial', paidDate, amountPaid)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: `Partial payment recorded: ${amountPaid}`,
  })
}

export async function splitInvoice(
  invoiceId: string,
  installments: Array<{ amount: number; due_date: string }>
): Promise<ActionResult<{ childIds: string[] }>> {
  return safeAction(async () => {
    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')

    // 1. Fetch parent invoice (must be status 'Sent' or 'Draft')
    const { data: parent, error: parentErr } = await supabaseAdmin
      .from('client_invoices')
      .select('*, client_invoice_items(*)')
      .eq('id', invoiceId)
      .single()

    if (parentErr || !parent) throw new Error(`Invoice not found: ${parentErr?.message || 'not found'}`)
    if (!['Sent', 'Draft'].includes(parent.status)) {
      throw new Error(`Cannot split invoice with status '${parent.status}' — must be Draft or Sent`)
    }

    // 2. Validate: sum of installment amounts must equal parent total
    const installmentSum = installments.reduce((sum, inst) => sum + inst.amount, 0)
    if (Math.abs(installmentSum - Number(parent.total)) >= 0.01) {
      throw new Error(`Installment sum (${installmentSum}) does not match invoice total (${parent.total})`)
    }

    // 3. Update parent: status = 'Split' (non-payable)
    await supabaseAdmin
      .from('client_invoices')
      .update({ status: 'Split', updated_at: new Date().toISOString() })
      .eq('id', invoiceId)

    // Audit trail
    const { logInvoiceAudit } = await import('@/lib/portal/invoice-audit')
    logInvoiceAudit({
      invoice_id: invoiceId,
      action: 'split',
      new_values: { status: 'Split', installments: installments.length },
      performed_by: 'system',
    })

    // Also update linked payment
    const { data: linkedPay } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('portal_invoice_id', invoiceId)
      .limit(1)
      .maybeSingle()
    if (linkedPay) {
      await supabaseAdmin.from('payments').update({
        status: 'Split',
        invoice_status: 'Split',
        updated_at: new Date().toISOString(),
      }).eq('id', linkedPay.id)
    }

    // 4. Create child invoices
    const childIds: string[] = []
    const childStatus = parent.status === 'Sent' ? 'Sent' : 'Draft'

    for (let idx = 0; idx < installments.length; idx++) {
      const inst = installments[idx]

      // Use a single line item per child with exact installment amount
      // This avoids rounding drift from proportionally scaling multiple items
      const lineItems = [{
        description: `Installment ${idx + 1}/${installments.length} — ${parent.invoice_number || 'Split'}`,
        unit_price: inst.amount,
        quantity: 1,
      }]

      const result = await createUnifiedInvoice({
        account_id: parent.account_id || undefined,
        contact_id: parent.contact_id || undefined,
        customer_id: parent.customer_id || undefined,
        line_items: lineItems,
        currency: parent.currency,
        due_date: inst.due_date,
        notes: parent.notes || undefined,
        message: parent.message || undefined,
        parent_invoice_id: invoiceId,
      })

      // If parent was 'Sent', update child to 'Sent' too
      if (childStatus === 'Sent') {
        await supabaseAdmin
          .from('client_invoices')
          .update({ status: 'Sent' })
          .eq('id', result.invoiceId)
        await supabaseAdmin
          .from('payments')
          .update({ status: 'Pending', invoice_status: 'Sent' })
          .eq('id', result.paymentId)
      }

      childIds.push(result.invoiceId)
    }

    revalidatePath('/portal/invoices')
    return { childIds }
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: `Invoice split into ${installments.length} installments`,
  })
}

// --- Void / Duplicate actions ---

export async function voidInvoice(invoiceId: string): Promise<ActionResult> {
  return safeAction(async () => {
    // Verify status allows voiding
    const { data: inv } = await supabaseAdmin
      .from('client_invoices')
      .select('status')
      .eq('id', invoiceId)
      .single()
    if (!inv) throw new Error('Invoice not found')
    if (!['Draft', 'Sent', 'Overdue'].includes(inv.status)) {
      throw new Error(`Cannot void invoice with status '${inv.status}'`)
    }

    await supabaseAdmin
      .from('client_invoices')
      .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
      .eq('id', invoiceId)

    const { logInvoiceAudit } = await import('@/lib/portal/invoice-audit')
    logInvoiceAudit({
      invoice_id: invoiceId,
      action: 'voided',
      previous_values: { status: inv.status },
      new_values: { status: 'Cancelled' },
      performed_by: 'client',
    })

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: 'Invoice voided by client',
  })
}

export async function duplicateInvoice(invoiceId: string): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  return safeAction(async () => {
    // Fetch source invoice with items
    const { data: source } = await supabaseAdmin
      .from('client_invoices')
      .select('*, client_invoice_items(*)')
      .eq('id', invoiceId)
      .single()
    if (!source) throw new Error('Invoice not found')

    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')
    const items = (source.client_invoice_items || []).map((item: { description: string; unit_price: number; quantity: number }) => ({
      description: item.description,
      unit_price: item.unit_price,
      quantity: item.quantity,
    }))

    const result = await createUnifiedInvoice({
      account_id: source.account_id || undefined,
      contact_id: source.contact_id || undefined,
      customer_id: source.customer_id || undefined,
      line_items: items,
      currency: source.currency as 'USD' | 'EUR',
      notes: source.notes || undefined,
      message: source.message || undefined,
    })

    revalidatePath('/portal/invoices')
    return { id: result.invoiceId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create', table_name: 'client_invoices', record_id: invoiceId,
    summary: `Invoice duplicated from ${invoiceId}`,
  })
}

// --- Template actions ---

export async function createTemplate(input: CreateTemplateInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createTemplateSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  return safeAction(async () => {
    const { data, error } = await supabaseAdmin
      .from('client_invoice_templates')
      .insert(parsed.data)
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
    return data
  }, {
    action_type: 'create', table_name: 'client_invoice_templates', account_id: parsed.data.account_id,
    summary: `Template created: ${parsed.data.name}`,
  })
}

export async function deleteTemplate(id: string, accountId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from('client_invoice_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'delete', table_name: 'client_invoice_templates', record_id: id,
    summary: 'Template deleted',
  })
}

export async function listTemplates(accountId: string) {
  const { data } = await supabaseAdmin
    .from('client_invoice_templates')
    .select('id, name, customer_id, currency, items, message, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })

  return data ?? []
}
