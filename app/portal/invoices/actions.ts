'use server'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import {
  createInvoiceSchema, updateInvoiceSchema, createCustomerSchema, createTemplateSchema,
  type CreateInvoiceInput, type UpdateInvoiceInput, type CreateCustomerInput, type CreateTemplateInput,
} from '@/lib/schemas/portal-invoice'
import {
  authorizeAccount, authorizeInvoice, belongsToAccount, actorLabel,
} from '@/lib/portal/invoice-access'
import { invoiceStatusRule } from '@/lib/portal/invoice-status'

// EVERY exported function here is a public endpoint (a 'use server' file). Each one MUST start with
// authorizeAccount / authorizeInvoice from lib/portal/invoice-access.ts, which takes the company from the
// STORED row. tests/unit/portal-invoice-actions-access.test.ts fails if an export skips the guard.

const round2 = (n: number) => Math.round(n * 100) / 100
const YMD = /^\d{4}-\d{2}-\d{2}$/

function deny(access: { error: string }): { success: false; error: string } {
  return { success: false, error: access.error }
}

export async function createCustomer(input: CreateCustomerInput): Promise<ActionResult<{ id: string }>> {
  const parsed = createCustomerSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  // Same capability as the Customers page; a teammate who may invoice can also add the customer in the form.
  let access = await authorizeAccount(parsed.data.account_id, 'sales_customers')
  if ('error' in access) access = await authorizeAccount(parsed.data.account_id, 'invoices_billing')
  if ('error' in access) return deny(access)

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

  const access = await authorizeAccount(parsed.data.account_id)
  if ('error' in access) return deny(access)
  const { accountId } = access

  // Everything the payload points at must belong to THIS company.
  if (!(await belongsToAccount('client_customers', parsed.data.customer_id, accountId))) {
    return { success: false, error: 'That customer does not belong to this company.' }
  }
  if (parsed.data.bank_account_id && !(await belongsToAccount('client_bank_accounts', parsed.data.bank_account_id, accountId))) {
    return { success: false, error: 'That bank account does not belong to this company.' }
  }

  return safeAction(async () => {
    const { items, recurring_frequency, recurring_end_date, ...invoiceData } = parsed.data
    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')

    const result = await createUnifiedInvoice({
      account_id: accountId,
      customer_id: invoiceData.customer_id,
      line_items: items.map(item => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: (invoiceData.currency || 'USD') as 'USD' | 'EUR',
      discount: invoiceData.discount,
      issue_date: invoiceData.issue_date && YMD.test(invoiceData.issue_date) ? invoiceData.issue_date : undefined,
      bank_account_id: invoiceData.bank_account_id ?? null,
      due_date: invoiceData.due_date || undefined,
      notes: invoiceData.notes || undefined,
      message: invoiceData.message || undefined,
      recurring_frequency: recurring_frequency || null,
      recurring_end_date: recurring_end_date || null,
    })

    revalidatePath('/portal/invoices')
    return { id: result.invoiceId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create', table_name: 'client_invoices', account_id: accountId,
    summary: `Invoice created`,
  })
}

export async function updateInvoice(input: UpdateInvoiceInput): Promise<ActionResult> {
  const parsed = updateInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  // The company is the STORED one. `parsed.data.account_id` (if the caller sent one) is never used.
  const access = await authorizeInvoice(parsed.data.id)
  if ('error' in access) return deny(access)
  const { accountId, user } = access

  const { data: current, error: readErr } = await supabaseAdmin
    .from('client_invoices')
    .select('status, subtotal, discount, tax_total, amount_paid, currency')
    .eq('id', parsed.data.id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (readErr || !current) return { success: false, error: 'Invoice not found' }
  if (!invoiceStatusRule(current.status)?.editable) {
    return { success: false, error: `A ${current.status} invoice cannot be edited.` }
  }

  if (parsed.data.customer_id && !(await belongsToAccount('client_customers', parsed.data.customer_id, accountId))) {
    return { success: false, error: 'That customer does not belong to this company.' }
  }
  if (parsed.data.bank_account_id && !(await belongsToAccount('client_bank_accounts', parsed.data.bank_account_id, accountId))) {
    return { success: false, error: 'That bank account does not belong to this company.' }
  }

  return safeAction(async () => {
    const { id, items } = parsed.data

    // WHITELIST. status, paid_date, account_id and every amount are NOT editable here: they only move through
    // the named actions (send, mark paid, partial payment, void) that enforce their own rules.
    const updates: Record<string, unknown> = {}
    const d = parsed.data
    if (d.customer_id !== undefined) updates.customer_id = d.customer_id
    if (d.currency !== undefined) updates.currency = d.currency
    if (d.issue_date !== undefined && YMD.test(d.issue_date)) updates.issue_date = d.issue_date
    if (d.due_date !== undefined) updates.due_date = d.due_date && YMD.test(d.due_date) ? d.due_date : null
    if (d.notes !== undefined) updates.notes = d.notes
    if (d.message !== undefined) updates.message = d.message
    if (d.bank_account_id !== undefined) updates.bank_account_id = d.bank_account_id

    // Totals are computed HERE from quantity x price, never trusted from the browser.
    let itemRows: Array<Record<string, unknown>> | null = null
    let subtotal = round2(Number(current.subtotal) || 0)
    let taxTotal = round2(Number(current.tax_total) || 0)
    if (items) {
      itemRows = items.map((item, i) => ({
        invoice_id: id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: round2(item.quantity * item.unit_price),
        sort_order: i,
      }))
      subtotal = round2(itemRows.reduce((sum, r) => sum + (r.amount as number), 0))
      taxTotal = 0 // the edit form has no tax field; the replaced lines carry none
    }
    const discount = round2(Math.min(Math.max(d.discount ?? (Number(current.discount) || 0), 0), subtotal))
    const total = round2(subtotal - discount + taxTotal)
    const paid = round2(Number(current.amount_paid) || 0)
    const due = round2(Math.max(total - paid, 0))
    Object.assign(updates, { subtotal, discount, tax_total: taxTotal, total, amount_due: due })
    // Edits can move a settled invoice back to open (higher total) or settle it (lower total).
    if (paid > 0) updates.status = due <= 0 ? 'Paid' : 'Partial'

    if (itemRows) {
      const { data: oldItems } = await supabaseAdmin.from('client_invoice_items').select('*').eq('invoice_id', id)
      const { error: delErr } = await supabaseAdmin.from('client_invoice_items').delete().eq('invoice_id', id)
      if (delErr) throw new Error(`Could not replace the invoice lines: ${delErr.message}`)
      const { error: insErr } = await supabaseAdmin.from('client_invoice_items').insert(itemRows as never)
      if (insErr) {
        // Put the old lines back so the invoice is never left empty.
        if (oldItems && oldItems.length > 0) await supabaseAdmin.from('client_invoice_items').insert(oldItems as never)
        throw new Error(`Could not save the invoice lines: ${insErr.message}`)
      }
    }

    const { data: written, error } = await supabaseAdmin
      .from('client_invoices')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
    if (error) throw new Error(error.message)
    if (!written || written.length === 0) throw new Error('Invoice not found')

    const { logInvoiceAudit } = await import('@/lib/portal/invoice-audit')
    logInvoiceAudit({
      invoice_id: id,
      action: 'edited',
      changed_fields: updates,
      performed_by: actorLabel(user),
    })

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: parsed.data.id,
    summary: `Invoice updated`,
  })
}

export async function markInvoiceAsPaid(invoiceId: string, paidDate: string): Promise<ActionResult> {
  const access = await authorizeInvoice(invoiceId)
  if ('error' in access) return deny(access)

  return safeAction(async () => {
    const { applyClientInvoicePayment } = await import('@/lib/portal/unified-invoice')
    const r = await applyClientInvoicePayment(invoiceId, 'rest', paidDate, actorLabel(access.user))
    if ('error' in r) throw new Error(r.error)
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
  const access = await authorizeInvoice(invoiceId)
  if ('error' in access) return deny(access)

  return safeAction(async () => {
    const { applyClientInvoicePayment } = await import('@/lib/portal/unified-invoice')
    const r = await applyClientInvoicePayment(invoiceId, amountPaid, paidDate, actorLabel(access.user))
    if ('error' in r) throw new Error(r.error)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: `Payment recorded: ${amountPaid}`,
  })
}

// splitInvoice was removed 2026-10-09: nothing in the app called it, it set the parent to Split before the children
// existed with no rollback, and accepted negative installments. Existing Split parents keep working
// (checkParentCompletion in lib/portal/unified-invoice.ts still closes a parent when its children are paid).

// --- Void / Duplicate actions ---

export async function voidInvoice(invoiceId: string): Promise<ActionResult> {
  const access = await authorizeInvoice(invoiceId)
  if ('error' in access) return deny(access)

  return safeAction(async () => {
    const { data: inv } = await supabaseAdmin
      .from('client_invoices')
      .select('status')
      .eq('id', invoiceId)
      .eq('account_id', access.accountId)
      .maybeSingle()
    if (!inv) throw new Error('Invoice not found')
    // The client's invoice tool follows the standard lifecycle: any invoice can be voided
    // (Draft/Sent/Overdue/Paid/Partial) — it's the client's own record, not a TD accounting document. Only an
    // already-voided invoice can't be re-voided, and a Split parent is structurally tied to its installment
    // children so it's left out.
    if (inv.status === 'Cancelled') throw new Error('Invoice is already voided')
    if (inv.status === 'Split') throw new Error('Cannot void a split invoice — void its installments instead')

    const { data: written, error } = await supabaseAdmin
      .from('client_invoices')
      .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('account_id', access.accountId)
      .not('status', 'in', '("Cancelled","Split")')
      .select('id')
    if (error) throw new Error(error.message)
    if (!written || written.length === 0) throw new Error('This invoice just changed. Please refresh and try again.')

    const { logInvoiceAudit } = await import('@/lib/portal/invoice-audit')
    logInvoiceAudit({
      invoice_id: invoiceId,
      action: 'voided',
      previous_values: { status: inv.status },
      new_values: { status: 'Cancelled' },
      performed_by: actorLabel(access.user),
    })

    revalidatePath('/portal/invoices')
  }, {
    action_type: 'update', table_name: 'client_invoices', record_id: invoiceId,
    summary: 'Invoice voided by client',
  })
}

export async function duplicateInvoice(invoiceId: string): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  const access = await authorizeInvoice(invoiceId)
  if ('error' in access) return deny(access)

  return safeAction(async () => {
    const { data: source } = await supabaseAdmin
      .from('client_invoices')
      .select('*, client_invoice_items(*)')
      .eq('id', invoiceId)
      .eq('account_id', access.accountId)
      .maybeSingle()
    if (!source) throw new Error('Invoice not found')

    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')
    const items = (source.client_invoice_items || []).map(
      (item: { description: string; unit_price: number; quantity: number; tax_rate: number | null }) => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
        tax_rate: item.tax_rate ?? undefined,
      }),
    )

    const result = await createUnifiedInvoice({
      account_id: access.accountId,
      customer_id: source.customer_id || undefined,
      line_items: items,
      currency: source.currency as 'USD' | 'EUR',
      discount: Number(source.discount) || 0,
      bank_account_id: source.bank_account_id || null,
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

  const access = await authorizeAccount(parsed.data.account_id)
  if ('error' in access) return deny(access)
  if (parsed.data.customer_id && !(await belongsToAccount('client_customers', parsed.data.customer_id, access.accountId))) {
    return { success: false, error: 'That customer does not belong to this company.' }
  }

  return safeAction(async () => {
    const { data, error } = await supabaseAdmin
      .from('client_invoice_templates')
      .insert({ ...parsed.data, account_id: access.accountId })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
    return data
  }, {
    action_type: 'create', table_name: 'client_invoice_templates', account_id: access.accountId,
    summary: `Template created: ${parsed.data.name}`,
  })
}

export async function deleteTemplate(id: string, accountId: string): Promise<ActionResult> {
  const access = await authorizeAccount(accountId)
  if ('error' in access) return deny(access)

  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from('client_invoice_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', access.accountId)
    if (error) throw new Error(error.message)
    revalidatePath('/portal/invoices')
  }, {
    action_type: 'delete', table_name: 'client_invoice_templates', record_id: id,
    summary: 'Template deleted',
  })
}

interface TemplateRow {
  id: string
  name: string
  customer_id: string | null
  currency: string
  items: { description: string; quantity: number; unit_price: number }[]
  message: string | null
  created_at: string
}

/** Returns an empty list (never throws) when the caller may not see this company, so a page never crashes on it. */
export async function listTemplates(accountId: string): Promise<TemplateRow[]> {
  const access = await authorizeAccount(accountId)
  if ('error' in access) return []

  const { data } = await supabaseAdmin
    .from('client_invoice_templates')
    .select('id, name, customer_id, currency, items, message, created_at')
    .eq('account_id', access.accountId)
    .order('created_at', { ascending: false })

  return (data ?? []) as unknown as TemplateRow[]
}
