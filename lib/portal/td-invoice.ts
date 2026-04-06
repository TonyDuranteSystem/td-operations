/**
 * TD Invoice System
 *
 * Creates invoices from Tony Durante LLC TO clients.
 * Writes to:
 *   1. payments (PRIMARY — CRM tracking, QB sync, staff-facing)
 *   2. client_expenses (MIRROR — client sees as incoming expense in portal)
 *
 * NEVER writes to client_invoices — that table is exclusively for
 * client-created sales invoices (their business, not ours).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateInvoiceNumber } from '@/lib/portal/invoice-number'

// ─── Types ──────────────────────────────────────────

export interface TDInvoiceInput {
  account_id?: string
  contact_id?: string
  line_items: Array<{
    description: string
    unit_price: number
    quantity?: number
    tax_rate?: number
  }>
  currency?: 'USD' | 'EUR'
  due_date?: string
  notes?: string
  message?: string
  mark_as_paid?: boolean
  paid_date?: string
  payment_method?: string
  whop_payment_id?: string
}

export interface TDInvoiceResult {
  paymentId: string
  expenseId: string
  invoiceNumber: string
  total: number
  status: string
}

// ─── Create TD Invoice ─────────────────────────────

export async function createTDInvoice(input: TDInvoiceInput): Promise<TDInvoiceResult> {
  const {
    account_id,
    contact_id,
    line_items,
    currency = 'USD',
    due_date,
    notes,
    message,
    mark_as_paid = false,
    paid_date,
    payment_method,
    whop_payment_id,
  } = input

  if (!account_id && !contact_id) {
    throw new Error('createTDInvoice: at least one of account_id or contact_id required')
  }

  // 1. Generate invoice number (INV-NNNNNN — global sequence, QB-compatible)
  const invoiceNumber = await generateInvoiceNumber()

  // 2. Calculate totals
  const items = line_items.map((item) => {
    const qty = item.quantity || 1
    const amount = item.unit_price * qty
    const taxRate = item.tax_rate || 0
    const taxAmount = Math.round(amount * taxRate * 100) / 100
    return {
      description: item.description,
      unit_price: item.unit_price,
      quantity: qty,
      amount,
      tax_rate: taxRate,
      tax_amount: taxAmount,
    }
  })
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0)
  const taxTotal = items.reduce((sum, i) => sum + i.tax_amount, 0)
  const total = subtotal + taxTotal

  const amountPaid = mark_as_paid ? total : 0
  const amountDue = Math.max(total - amountPaid, 0)

  const paymentStatus = mark_as_paid ? 'Paid' : 'Pending'
  const invoiceStatus = mark_as_paid ? 'Paid' : 'Draft'

  const today = new Date().toISOString().split('T')[0]
  const paidDateVal = mark_as_paid ? (paid_date || today) : null

  // 3. Create payments record (PRIMARY — CRM + QB source of truth)
  const { data: payment, error: payErr } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
      invoice_number: invoiceNumber,
      description: items[0]?.description || 'Invoice',
      amount: total,
      amount_paid: amountPaid,
      amount_due: amountDue,
      amount_currency: currency,
      subtotal,
      discount: 0,
      total,
      status: paymentStatus,
      invoice_status: invoiceStatus,
      issue_date: today,
      due_date: due_date || null,
      paid_date: paidDateVal,
      payment_method: payment_method || null,
      whop_payment_id: whop_payment_id || null,
      notes: notes || null,
      message: message || null,
      qb_sync_status: 'pending',
    })
    .select('id')
    .single()

  if (payErr || !payment) {
    throw new Error(`Failed to create payment: ${payErr?.message}`)
  }

  // 4. Create payment_items
  await supabaseAdmin.from('payment_items').insert(
    items.map((item, i) => ({
      payment_id: payment.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      sort_order: i,
    }))
  )

  // 5. Generate internal expense reference
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

  // 6. Create client_expenses record (MIRROR — client sees as incoming expense)
  const { data: expense, error: expErr } = await supabaseAdmin
    .from('client_expenses')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
      vendor_name: 'Tony Durante LLC',
      invoice_number: invoiceNumber,
      internal_ref: internalRef,
      description: items[0]?.description || 'Service invoice',
      currency,
      subtotal,
      tax_amount: taxTotal,
      total,
      issue_date: today,
      due_date: due_date || null,
      paid_date: paidDateVal,
      status: mark_as_paid ? 'Paid' : 'Pending',
      source: 'td_invoice',
      td_payment_id: payment.id,
      notes: notes || null,
      category: 'Services',
    })
    .select('id')
    .single()

  if (expErr || !expense) {
    // Payment was created but expense mirror failed — log but don't fail
    console.error(`[td-invoice] expense mirror failed for ${invoiceNumber}: ${expErr?.message}`)
    return {
      paymentId: payment.id,
      expenseId: '',
      invoiceNumber,
      total,
      status: invoiceStatus,
    }
  }

  // 7. Create expense line items
  await supabaseAdmin.from('client_expense_items').insert(
    items.map((item, i) => ({
      expense_id: expense.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      sort_order: i,
    }))
  )

  return {
    paymentId: payment.id,
    expenseId: expense.id,
    invoiceNumber,
    total,
    status: invoiceStatus,
  }
}

// ─── Sync TD Invoice Status ────────────────────────

/**
 * Sync status from payments → client_expenses.
 * One-way: payments is the source of truth for TD invoices.
 */
export async function syncTDInvoiceStatus(
  paymentId: string,
  newStatus: string,
  paidDate?: string,
  amountPaid?: number
): Promise<void> {
  // Map payment status → expense status
  const statusMap: Record<string, string> = {
    'Pending': 'Pending',
    'Paid': 'Paid',
    'Partial': 'Pending',
    'Overdue': 'Overdue',
    'Cancelled': 'Cancelled',
    'Split': 'Cancelled',
  }

  const expenseStatus = statusMap[newStatus] || newStatus

  const updates: Record<string, unknown> = {
    status: expenseStatus,
    updated_at: new Date().toISOString(),
  }
  if (paidDate) updates.paid_date = paidDate
  if (amountPaid !== undefined) {
    // For partial payments, keep as Pending (client still owes)
    if (amountPaid > 0 && expenseStatus !== 'Paid') {
      updates.status = 'Pending'
    }
  }

  await supabaseAdmin
    .from('client_expenses')
    .update(updates)
    .eq('td_payment_id', paymentId)
}
