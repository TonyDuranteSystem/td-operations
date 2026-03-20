'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { safeAction, updateWithLock, type ActionResult } from '@/lib/server-action'
import {
  createInvoiceSchema,
  createCreditNoteSchema,
  type CreateInvoiceInput,
  type CreateCreditNoteInput,
} from '@/lib/schemas/invoice'
import { generateInvoiceNumber } from '@/lib/invoice-number'
import { syncPaymentToQB, syncVoidToQB } from '@/lib/qb-sync'

// ── Create Invoice (Draft) ─────────────────────────────────────────

export async function createInvoice(
  input: CreateInvoiceInput
): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  const parsed = createInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { items, ...invoiceData } = parsed.data
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const total = subtotal - (invoiceData.discount || 0)
  const invoiceNumber = await generateInvoiceNumber()

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()

    // Insert payment record with invoice fields
    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .insert({
        account_id: invoiceData.account_id,
        description: invoiceData.description,
        amount: total,
        amount_currency: invoiceData.amount_currency,
        due_date: invoiceData.due_date || null,
        status: 'Pending',
        invoice_number: invoiceNumber,
        invoice_status: 'Draft',
        issue_date: invoiceData.issue_date,
        subtotal,
        discount: invoiceData.discount || 0,
        total,
        message: invoiceData.message || null,
        billing_entity_id: invoiceData.billing_entity_id || null,
        qb_sync_status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single()

    if (payErr) throw new Error(payErr.message)

    // Insert line items
    const itemRows = items.map((item, i) => ({
      payment_id: payment.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      sort_order: item.sort_order ?? i,
    }))

    const { error: itemErr } = await supabase
      .from('payment_items')
      .insert(itemRows)

    if (itemErr) throw new Error(`Items: ${itemErr.message}`)

    revalidatePath('/payments')
    return { id: payment.id, invoice_number: invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: invoiceData.account_id,
    summary: `Invoice ${invoiceNumber} created (Draft)`,
    details: { invoice_number: invoiceNumber, total, currency: invoiceData.amount_currency, items_count: items.length },
  })
}

// ── Update Invoice (Draft only) ─────────────────────────────────────

export async function updateInvoice(
  paymentId: string,
  updatedAt: string,
  input: Omit<CreateInvoiceInput, 'account_id'>
): Promise<ActionResult> {
  const items = input.items
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const total = subtotal - (input.discount || 0)

  return safeAction(async () => {
    const supabase = createClient()

    // Verify still Draft
    const { data: current } = await supabase
      .from('payments')
      .select('invoice_status')
      .eq('id', paymentId)
      .single()

    if (current?.invoice_status !== 'Draft') {
      throw new Error('Can only edit Draft invoices')
    }

    // Update payment record
    const updates = {
      description: input.description,
      amount: total,
      amount_currency: input.amount_currency,
      due_date: input.due_date || null,
      issue_date: input.issue_date,
      subtotal,
      discount: input.discount || 0,
      total,
      message: input.message || null,
      billing_entity_id: input.billing_entity_id || null,
    }

    const result = await updateWithLock('payments', paymentId, updates, updatedAt)
    if (!result.success) throw new Error(result.error)

    // Replace items: delete old, insert new
    await supabase.from('payment_items').delete().eq('payment_id', paymentId)
    const itemRows = items.map((item, i) => ({
      payment_id: paymentId,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      sort_order: item.sort_order ?? i,
    }))
    const { error: itemErr } = await supabase.from('payment_items').insert(itemRows)
    if (itemErr) throw new Error(`Items: ${itemErr.message}`)

    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice updated`,
    details: { total, items_count: items.length },
  })
}

// ── Mark Invoice Paid ───────────────────────────────────────────────

export async function markInvoicePaid(
  paymentId: string,
  updatedAt: string,
  paymentMethod?: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const today = new Date().toISOString().split('T')[0]
    const updates: Record<string, unknown> = {
      status: 'Paid',
      invoice_status: 'Paid',
      paid_date: today,
    }
    if (paymentMethod) updates.payment_method = paymentMethod

    const result = await updateWithLock('payments', paymentId, updates, updatedAt)
    if (!result.success) throw new Error(result.error)

    // QB sync (non-blocking best-effort)
    syncPaymentToQB(paymentId, {
      paymentDate: today,
      paymentMethod: paymentMethod,
    }).catch(() => {})

    revalidatePath('/payments')
    revalidatePath('/accounts')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice marked Paid',
    details: { payment_method: paymentMethod },
  })
}

// ── Void Invoice ────────────────────────────────────────────────────

export async function voidInvoice(
  paymentId: string,
  updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await updateWithLock('payments', paymentId, {
      invoice_status: 'Voided',
      status: 'Waived',
    }, updatedAt)
    if (!result.success) throw new Error(result.error)

    // QB sync (non-blocking best-effort)
    syncVoidToQB(paymentId).catch(() => {})

    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice voided',
  })
}

// ── Create Credit Note ──────────────────────────────────────────────

export async function createCreditNote(
  input: CreateCreditNoteInput
): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  const parsed = createCreditNoteSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { items, ...noteData } = parsed.data
  const subtotal = items.reduce((sum, item) => sum + Math.abs(item.amount), 0)
  const total = -subtotal // Credit notes are negative
  const invoiceNumber = await generateInvoiceNumber()

  return safeAction(async () => {
    const supabase = createClient()
    const now = new Date().toISOString()

    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .insert({
        account_id: noteData.account_id,
        description: noteData.description,
        amount: total,
        amount_currency: noteData.amount_currency,
        status: 'Paid', // Credits are immediately "settled"
        invoice_number: invoiceNumber,
        invoice_status: 'Credit',
        issue_date: noteData.issue_date,
        subtotal: -subtotal,
        discount: 0,
        total,
        credit_for_payment_id: noteData.credit_for_payment_id || null,
        referral_partner_id: noteData.referral_partner_id || null,
        qb_sync_status: 'pending',
        paid_date: noteData.issue_date,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single()

    if (payErr) throw new Error(payErr.message)

    const itemRows = items.map((item, i) => ({
      payment_id: payment.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: -Math.abs(item.unit_price),
      amount: -Math.abs(item.amount),
      sort_order: item.sort_order ?? i,
    }))

    const { error: itemErr } = await supabase.from('payment_items').insert(itemRows)
    if (itemErr) throw new Error(`Items: ${itemErr.message}`)

    revalidatePath('/payments')
    return { id: payment.id, invoice_number: invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: noteData.account_id,
    summary: `Credit note ${invoiceNumber} created`,
    details: { invoice_number: invoiceNumber, total, referral_partner_id: noteData.referral_partner_id },
  })
}

// ── Get Invoice with Items ──────────────────────────────────────────

export async function getInvoiceWithItems(paymentId: string) {
  const supabase = createClient()

  const [paymentRes, itemsRes] = await Promise.all([
    supabase
      .from('payments')
      .select('*, accounts:account_id(id, company_name)')
      .eq('id', paymentId)
      .single(),
    supabase
      .from('payment_items')
      .select('*')
      .eq('payment_id', paymentId)
      .order('sort_order', { ascending: true }),
  ])

  if (paymentRes.error) throw new Error(paymentRes.error.message)

  return {
    payment: paymentRes.data,
    items: itemsRes.data ?? [],
  }
}
