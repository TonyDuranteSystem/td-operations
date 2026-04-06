/**
 * Client Sales Invoice System
 *
 * Creates invoices that CLIENTS send to THEIR customers (fatture vendita).
 * Writes ONLY to client_invoices — no payments mirror, no QB sync.
 *
 * For TD LLC invoices TO clients, use createTDInvoice from lib/portal/td-invoice.ts.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateInvoiceNumber } from '@/lib/portal/invoice-number'
import { logInvoiceAudit } from '@/lib/portal/invoice-audit'

// ─── Types ──────────────────────────────────────────────

export interface UnifiedInvoiceInput {
  account_id?: string
  contact_id?: string
  customer_id?: string  // client_customers.id — resolved internally if not provided
  line_items: Array<{
    description: string
    unit_price: number
    quantity?: number
    tax_rate?: number  // e.g. 0.22 for 22% VAT — display only
  }>
  currency?: 'USD' | 'EUR'
  due_date?: string
  notes?: string       // internal notes (not visible to client's customer)
  message?: string     // payment terms visible to client's customer
  mark_as_paid?: boolean
  paid_date?: string
  recurring_frequency?: 'monthly' | 'quarterly' | 'yearly' | null
  recurring_end_date?: string | null
  recurring_parent_id?: string | null
  amount_paid?: number
  parent_invoice_id?: string | null
}

export interface UnifiedInvoiceResult {
  invoiceId: string
  paymentId: string  // kept for backward compat — always empty string
  invoiceNumber: string
  total: number
  status: string
}

// ─── Create Client Sales Invoice ────────────────────────

/**
 * Create a client sales invoice (client → their customer).
 * Writes to client_invoices ONLY. No payments mirror. No QB sync.
 */
export async function createUnifiedInvoice(input: UnifiedInvoiceInput): Promise<UnifiedInvoiceResult> {
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
    recurring_frequency,
    recurring_end_date,
    recurring_parent_id,
  } = input

  if (!account_id && !contact_id) {
    throw new Error('createUnifiedInvoice: at least one of account_id or contact_id required')
  }

  // 1. Resolve or create customer
  let customerId = input.customer_id
  if (!customerId) {
    customerId = await resolveCustomerId(account_id, contact_id)
  }

  // 2. Generate invoice number (INV-NNNNNN — global sequence)
  const invoiceNumber = await generateInvoiceNumber()

  // 3. Calculate totals (with optional tax)
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

  const effectiveAmountPaid = input.amount_paid ?? (mark_as_paid ? total : 0)
  const effectiveAmountDue = Math.max(total - effectiveAmountPaid, 0)

  let status: string
  if (mark_as_paid || effectiveAmountDue <= 0) {
    status = 'Paid'
  } else if (effectiveAmountPaid > 0 && effectiveAmountPaid < total) {
    status = 'Partial'
  } else {
    status = 'Draft'
  }

  const today = new Date().toISOString().split('T')[0]
  const paidDateVal = mark_as_paid ? (paid_date || today) : null

  // 4. Create client_invoices record (source = 'client' by default from DB)
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from('client_invoices')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
      customer_id: customerId,
      invoice_number: invoiceNumber,
      status,
      currency,
      subtotal,
      discount: 0,
      tax_total: taxTotal,
      total,
      amount_paid: effectiveAmountPaid,
      amount_due: effectiveAmountDue,
      issue_date: today,
      due_date: due_date || null,
      paid_date: paidDateVal,
      notes: notes || null,
      message: message || null,
      recurring_frequency: recurring_frequency || null,
      recurring_end_date: recurring_end_date || null,
      recurring_parent_id: recurring_parent_id || null,
      parent_invoice_id: input.parent_invoice_id || null,
      source: 'client',
    })
    .select('id, invoice_number')
    .single()

  if (invErr || !invoice) {
    throw new Error(`Failed to create client_invoice: ${invErr?.message}`)
  }

  // 5. Create line items
  const itemRows = items.map((item, i) => ({
    invoice_id: invoice.id,
    description: item.description,
    unit_price: item.unit_price,
    quantity: item.quantity,
    amount: item.amount,
    tax_rate: item.tax_rate,
    tax_amount: item.tax_amount,
    sort_order: i,
  }))
  await supabaseAdmin.from('client_invoice_items').insert(itemRows)

  // 6. Audit trail
  logInvoiceAudit({
    invoice_id: invoice.id,
    action: 'created',
    new_values: { invoice_number: invoiceNumber, total, status, currency, tax_total: taxTotal },
    performed_by: 'client',
  })

  return {
    invoiceId: invoice.id,
    paymentId: '',  // No payments mirror for client sales invoices
    invoiceNumber,
    total,
    status,
  }
}

// ─── Client Sales Invoice Status Sync ───────────────────

/**
 * Update status on a client sales invoice.
 * Only operates on client_invoices — no payments sync.
 * For TD invoice sync, use syncTDInvoiceStatus from td-invoice.ts.
 */
export async function syncInvoiceStatus(
  source: 'invoice' | 'payment',
  id: string,
  newStatus: string,
  paidDate?: string,
  amountPaid?: number
): Promise<{ synced: boolean; linkedId?: string }> {

  // For source='payment', this is a legacy call from CRM actions that still
  // reference old portal_invoice_id links. Handle gracefully.
  if (source === 'payment') {
    // Update the payment record
    const payUpdates: Record<string, unknown> = {
      status: newStatus === 'Paid' ? 'Paid' : newStatus === 'Overdue' ? 'Overdue' : newStatus,
      invoice_status: newStatus,
      updated_at: new Date().toISOString(),
    }
    if (paidDate) payUpdates.paid_date = paidDate
    if (amountPaid !== undefined) {
      payUpdates.amount_paid = amountPaid
    }
    await supabaseAdmin.from('payments').update(payUpdates).eq('id', id)

    // Also sync to client_expenses (TD invoice → expense mirror)
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(id, newStatus, paidDate, amountPaid)

    // Legacy: also update client_invoices if portal_invoice_id exists (for old records)
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('portal_invoice_id')
      .eq('id', id)
      .single()
    if (payment?.portal_invoice_id) {
      const invUpdates: Record<string, unknown> = {
        status: newStatus,
        updated_at: new Date().toISOString(),
      }
      if (paidDate) invUpdates.paid_date = paidDate
      if (amountPaid !== undefined) {
        // Calculate new amounts
        const { data: inv } = await supabaseAdmin
          .from('client_invoices')
          .select('total, amount_paid')
          .eq('id', payment.portal_invoice_id)
          .single()
        if (inv) {
          const currentPaid = Number(inv.amount_paid) || 0
          const newPaid = currentPaid + amountPaid
          const total = Number(inv.total)
          invUpdates.amount_paid = newPaid
          invUpdates.amount_due = Math.max(total - newPaid, 0)
          if (newPaid >= total) invUpdates.status = 'Paid'
          else if (newPaid > 0) invUpdates.status = 'Partial'
        }
      }
      await supabaseAdmin.from('client_invoices').update(invUpdates).eq('id', payment.portal_invoice_id)
    }

    return { synced: true, linkedId: payment?.portal_invoice_id || undefined }
  }

  // source === 'invoice' — direct client_invoices update
  if (amountPaid !== undefined) {
    const { data: inv } = await supabaseAdmin
      .from('client_invoices')
      .select('total, amount_paid')
      .eq('id', id)
      .single()

    if (inv) {
      const currentAmountPaid = Number(inv.amount_paid) || 0
      const newAmountPaid = currentAmountPaid + amountPaid
      const total = Number(inv.total)
      const newAmountDue = Math.max(total - newAmountPaid, 0)

      if (newAmountDue <= 0) newStatus = 'Paid'
      else if (newAmountPaid > 0) newStatus = 'Partial'

      const invUpdates: Record<string, unknown> = {
        status: newStatus,
        amount_paid: newAmountPaid,
        amount_due: newAmountDue,
        updated_at: new Date().toISOString(),
      }
      if (paidDate) invUpdates.paid_date = paidDate
      await supabaseAdmin.from('client_invoices').update(invUpdates).eq('id', id)

      logInvoiceAudit({
        invoice_id: id,
        action: newStatus === 'Paid' ? 'paid' : 'partial_payment',
        previous_values: { amount_paid: currentAmountPaid },
        new_values: { amount_paid: newAmountPaid, amount_due: newAmountDue, status: newStatus },
        performed_by: 'client',
      })

      await checkParentCompletion(id)
      return { synced: true }
    }
  }

  // Simple status change (no amount)
  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  }
  if (paidDate) updates.paid_date = paidDate

  await supabaseAdmin.from('client_invoices').update(updates).eq('id', id)

  logInvoiceAudit({
    invoice_id: id,
    action: newStatus === 'Paid' ? 'paid' : 'status_changed',
    new_values: { status: newStatus, ...(paidDate ? { paid_date: paidDate } : {}) },
    performed_by: 'client',
  })

  if (newStatus === 'Paid') await checkParentCompletion(id)
  return { synced: true }
}

// ─── Parent Completion Check (Split Invoices) ─────────

/**
 * When a child invoice of a split is marked Paid,
 * check if ALL children are Paid → mark parent as Paid too.
 */
async function checkParentCompletion(invoiceId: string): Promise<void> {
  const { data: inv } = await supabaseAdmin
    .from('client_invoices')
    .select('parent_invoice_id')
    .eq('id', invoiceId)
    .single()

  if (!inv?.parent_invoice_id) return

  const { data: children } = await supabaseAdmin
    .from('client_invoices')
    .select('status')
    .eq('parent_invoice_id', inv.parent_invoice_id)

  if (children?.length && children.every(c => c.status === 'Paid')) {
    const today = new Date().toISOString().split('T')[0]

    const { data: parentInv } = await supabaseAdmin
      .from('client_invoices')
      .select('total')
      .eq('id', inv.parent_invoice_id)
      .single()
    const parentTotal = parentInv ? Number(parentInv.total) : 0

    await supabaseAdmin.from('client_invoices').update({
      status: 'Paid',
      amount_paid: parentTotal,
      amount_due: 0,
      paid_date: today,
      updated_at: new Date().toISOString(),
    }).eq('id', inv.parent_invoice_id)
  }
}

// ─── Internal Helpers ───────────────────────────────────

async function resolveCustomerId(accountId?: string, contactId?: string): Promise<string> {
  const matchCol = accountId ? 'account_id' : 'contact_id'
  const matchVal = accountId || contactId

  const { data: existing } = await supabaseAdmin
    .from('client_customers')
    .select('id')
    .eq(matchCol, matchVal!)
    .limit(1)
    .maybeSingle()

  if (existing) return existing.id

  let name = 'Unknown'
  let email = ''

  if (accountId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()
    if (account) name = account.company_name

    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(email)')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (link) {
      const c = link.contacts as unknown as { email: string }
      email = c?.email || ''
    }
  } else if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name, email')
      .eq('id', contactId)
      .single()
    if (contact) {
      name = contact.full_name
      email = contact.email || ''
    }
  }

  const { data: created, error } = await supabaseAdmin
    .from('client_customers')
    .insert({
      account_id: accountId || null,
      contact_id: contactId || null,
      name,
      email,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create customer: ${error.message}`)
  return created.id
}
