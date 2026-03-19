'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { createInvoiceSchema, updateInvoiceSchema, createCustomerSchema, createTemplateSchema } from '@/lib/schemas/portal-invoice'
import type { CreateInvoiceInput, UpdateInvoiceInput, CreateCustomerInput, CreateTemplateInput } from '@/lib/schemas/portal-invoice'
import { generateInvoiceNumber } from '@/lib/portal/invoice-number'

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
    const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
    const total = subtotal - (invoiceData.discount || 0)
    const invoiceNumber = await generateInvoiceNumber(invoiceData.account_id)

    // Calculate next recurring date if frequency is set
    let recurringNextDate: string | null = null
    if (recurring_frequency && invoiceData.issue_date) {
      const issueDate = new Date(invoiceData.issue_date)
      if (recurring_frequency === 'monthly') issueDate.setMonth(issueDate.getMonth() + 1)
      else if (recurring_frequency === 'quarterly') issueDate.setMonth(issueDate.getMonth() + 3)
      else if (recurring_frequency === 'yearly') issueDate.setFullYear(issueDate.getFullYear() + 1)
      recurringNextDate = issueDate.toISOString().split('T')[0]
    }

    // Create invoice
    const { data: invoice, error } = await supabaseAdmin
      .from('client_invoices')
      .insert({
        ...invoiceData,
        invoice_number: invoiceNumber,
        subtotal,
        total: Math.max(total, 0),
        status: 'Draft',
        recurring_frequency: recurring_frequency || null,
        recurring_next_date: recurringNextDate,
        recurring_end_date: recurring_end_date || null,
      })
      .select('id, invoice_number')
      .single()

    if (error) throw new Error(error.message)

    // Create line items
    const itemRows = items.map((item, i) => ({
      invoice_id: invoice.id,
      ...item,
      sort_order: i,
    }))

    const { error: itemsError } = await supabaseAdmin
      .from('client_invoice_items')
      .insert(itemRows)

    if (itemsError) throw new Error(itemsError.message)

    revalidatePath('/portal/invoices')
    return invoice
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
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: parsed.data.id,
    summary: `Invoice updated`,
  })
}

export async function markInvoiceAsPaid(invoiceId: string, paidDate: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from('client_invoices')
      .update({ status: 'Paid', paid_date: paidDate, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: 'Invoice marked as paid',
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
