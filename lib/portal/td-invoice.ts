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
import { dbWrite, dbWriteSafe } from '@/lib/db'
import { generateInvoiceNumber, isUniqueViolation } from '@/lib/portal/invoice-number'

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
  /** Bank account to use for this invoice. Honored by sendTDInvoice when rendering
   *  PDF + email bank block. Null falls back to 'auto' (EUR→Airwallex, USD→Relay). */
  bank_preference?: 'auto' | 'relay' | 'mercury' | 'revolut' | 'airwallex'
  /**
   * Optional content-level idempotency key. If provided and a payments row
   * with this key already exists, returns the existing row (no new invoice
   * created). Callers use natural keys per flow, e.g.:
   *   'offer-signed:TOKEN:CONTACT_ID'
   *   'annual-installment:ACCOUNT_ID:1:YEAR'
   *   'manual-crm:ACCOUNT_ID:LINE_ITEMS_HASH'
   * Callers without a natural key leave it undefined and get no dedup.
   */
  idempotency_key?: string
  /**
   * Optional payment-type label for `payments.installment`. One of the
   * six values in `payment_type_enum`: 'Setup Fee', 'Installment 1 (Jan)',
   * 'Installment 2 (Jun)', 'Annual Payment', 'One-Time Service', 'Custom'.
   * Leave undefined for one-off invoices that don't fit the enum.
   */
  installment?: string
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
    bank_preference,
    idempotency_key,
    installment,
  } = input

  if (!account_id && !contact_id) {
    throw new Error('createTDInvoice: at least one of account_id or contact_id required')
  }

  // 0. Idempotency check — if a payments row already exists with this key,
  //    return it instead of creating a new invoice.
  if (idempotency_key) {
    const existing = await findByIdempotencyKey(idempotency_key)
    if (existing) return existing
  }

  // 1. Calculate totals
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

  // 2. Generate invoice number + insert payments row, with retry on unique-violation.
  //    The generator is not race-safe on its own; the partial unique index
  //    uq_payments_invoice_number catches concurrent collisions and we retry.
  //    Idempotency-key unique index is a secondary guard in case a concurrent
  //    caller wrote a row with the same key between our step-0 check and our insert.
  const MAX_INSERT_RETRIES = 10
  let invoiceNumber = ''
  let paymentId = ''
  let lastError: { message?: string; code?: string; details?: string } | null = null

  for (let attempt = 0; attempt < MAX_INSERT_RETRIES; attempt++) {
    invoiceNumber = await generateInvoiceNumber()

    // eslint-disable-next-line no-restricted-syntax -- createTDInvoice IS the single-entry helper for new TD invoices; retry loop needs raw Supabase error codes which dbWrite strips.
    const { data, error } = await supabaseAdmin
      .from('payments')
      .insert({
        account_id: account_id || null,
        contact_id: contact_id || null,
        invoice_number: invoiceNumber,
        idempotency_key: idempotency_key || null,
        installment: installment || null,
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
        bank_preference: bank_preference || null,
        qb_sync_status: 'pending',
      })
      .select('id')
      .single()

    if (!error && data) {
      paymentId = data.id
      break
    }

    lastError = error

    // Another caller won the invoice_number race. Regenerate + retry.
    if (isUniqueViolation(error, 'uq_payments_invoice_number')) {
      continue
    }

    // Another caller wrote a row with our idempotency_key between our step-0
    // check and this insert. Fetch and return theirs.
    if (idempotency_key && isUniqueViolation(error, 'uq_payments_idempotency_key')) {
      const winner = await findByIdempotencyKey(idempotency_key)
      if (winner) return winner
      // Unlikely fall-through: the winning row disappeared before we could read it.
      // Break out and let the caller see the error.
    }

    // Any other error — bubble up.
    throw new Error(`createTDInvoice[payments.insert]: ${error?.message || 'unknown'}`)
  }

  if (!paymentId) {
    throw new Error(
      `createTDInvoice: exhausted ${MAX_INSERT_RETRIES} retries on invoice_number generation; last error: ${lastError?.message || 'unknown'}`,
    )
  }

  // 3. Create payment_items
  await dbWrite(
    supabaseAdmin.from('payment_items').insert(
      items.map((item, i) => ({
        payment_id: paymentId,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: item.amount,
        sort_order: i,
      }))
    ),
    'payment_items.insert'
  )

  // 4. Generate internal expense reference
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

  // 5. Create client_expenses record (MIRROR — client sees as incoming expense)
  const { data: expense, error: expErr } = await dbWriteSafe(
    supabaseAdmin
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
        td_payment_id: paymentId,
        notes: notes || null,
        category: 'Services',
      })
      .select('id')
      .single(),
    'client_expenses.insert'
  )

  if (expErr || !expense) {
    // Payment was created but expense mirror failed — log but don't fail
    console.error(`[td-invoice] expense mirror failed for ${invoiceNumber}: ${expErr}`)
    return {
      paymentId,
      expenseId: '',
      invoiceNumber,
      total,
      status: invoiceStatus,
    }
  }

  // 6. Create expense line items
  await dbWriteSafe(
    supabaseAdmin.from('client_expense_items').insert(
      items.map((item, i) => ({
        expense_id: expense.id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: item.amount,
        sort_order: i,
      }))
    ),
    'client_expense_items.insert'
  )

  return {
    paymentId,
    expenseId: expense.id,
    invoiceNumber,
    total,
    status: invoiceStatus,
  }
}

// ─── Idempotency helper ────────────────────────────

/**
 * Look up an existing TD invoice by idempotency_key.
 * Returns null if none exists.
 */
async function findByIdempotencyKey(key: string): Promise<TDInvoiceResult | null> {
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, total, invoice_status')
    .eq('idempotency_key', key)
    .limit(1)
    .maybeSingle()

  if (!payment || !payment.invoice_number) return null

  const { data: expense } = await supabaseAdmin
    .from('client_expenses')
    .select('id')
    .eq('td_payment_id', payment.id)
    .limit(1)
    .maybeSingle()

  return {
    paymentId: payment.id,
    expenseId: expense?.id || '',
    invoiceNumber: payment.invoice_number,
    total: Number(payment.total) || 0,
    status: (payment.invoice_status as string) || 'Pending',
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

  await dbWriteSafe(
    supabaseAdmin
      .from('client_expenses')
      .update(updates)
      .eq('td_payment_id', paymentId),
    'client_expenses.update'
  )
}

// ─── Reconcile TD Invoice Mirror (task 918fe55e) ─────

export interface ReconcileTDMirrorResult {
  success: boolean
  payment_id: string
  changed: boolean
  before?: { ce_status: string | null; ce_paid_date: string | null }
  after?: { ce_status: string | null; ce_paid_date: string | null }
  error?: string
}

/**
 * Force the `client_expenses` mirror row to match the current `payments`
 * row for a given payment. Source of truth is `payments`. Used by:
 *   - the CRM "Sync Mirror" admin button (manual repair for one invoice)
 *   - the one-time backfill for the 6 Pattern A stuck invoices
 *   - future reconciliation cron (not yet built)
 *
 * Idempotent — re-running is safe if state already matches.
 */
export async function reconcileTDInvoiceMirror(
  paymentId: string,
): Promise<ReconcileTDMirrorResult> {
  const { data: payment, error: payErr } = await supabaseAdmin
    .from('payments')
    .select('id, status, paid_date, amount_paid')
    .eq('id', paymentId)
    .single()

  if (payErr || !payment) {
    return {
      success: false,
      payment_id: paymentId,
      changed: false,
      error: `Payment not found: ${payErr?.message || 'unknown'}`,
    }
  }

  const { data: beforeExpense } = await supabaseAdmin
    .from('client_expenses')
    .select('status, paid_date')
    .eq('td_payment_id', paymentId)
    .maybeSingle()

  await syncTDInvoiceStatus(
    paymentId,
    (payment.status as string | null) ?? 'Pending',
    payment.paid_date as string | undefined,
    payment.amount_paid as number | undefined,
  )

  const { data: afterExpense } = await supabaseAdmin
    .from('client_expenses')
    .select('status, paid_date')
    .eq('td_payment_id', paymentId)
    .maybeSingle()

  const changed =
    (beforeExpense?.status ?? null) !== (afterExpense?.status ?? null) ||
    (beforeExpense?.paid_date ?? null) !== (afterExpense?.paid_date ?? null)

  return {
    success: true,
    payment_id: paymentId,
    changed,
    before: {
      ce_status: beforeExpense?.status ?? null,
      ce_paid_date: beforeExpense?.paid_date ?? null,
    },
    after: {
      ce_status: afterExpense?.status ?? null,
      ce_paid_date: afterExpense?.paid_date ?? null,
    },
  }
}
