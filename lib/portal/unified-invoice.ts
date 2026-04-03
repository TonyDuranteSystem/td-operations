/**
 * Unified Invoice System
 *
 * ALL invoice creation goes through this module.
 * Writes to BOTH tables (client_invoices PRIMARY, payments TRACKING) with FK link.
 * Bidirectional status sync keeps both tables in lockstep.
 *
 * Architecture:
 *   client_invoices (INV-2026-XXX) ← PRIMARY (client sees in portal)
 *        ↕ portal_invoice_id FK
 *   payments (same INV number) ← TRACKING (staff sees in CRM)
 *        ↓ qb_invoice_id
 *   QuickBooks ← ACCOUNTING (downstream, async)
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
  notes?: string       // internal notes (not visible to client)
  message?: string     // payment terms visible to client
  mark_as_paid?: boolean
  paid_date?: string
  payment_method?: string
  whop_payment_id?: string
  recurring_frequency?: 'monthly' | 'quarterly' | 'yearly' | null
  recurring_end_date?: string | null
  recurring_parent_id?: string | null
  amount_paid?: number
  parent_invoice_id?: string | null
}

export interface UnifiedInvoiceResult {
  invoiceId: string
  paymentId: string
  invoiceNumber: string
  total: number
  status: string
}

// ─── Create Unified Invoice ─────────────────────────────

/**
 * Create an invoice in BOTH client_invoices and payments.
 * client_invoices is PRIMARY (portal-facing), payments is TRACKING (CRM).
 * Linked via payments.portal_invoice_id FK.
 *
 * Returns IDs for both records + the canonical INV-YYYY-SEQ number.
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
    payment_method,
    whop_payment_id,
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

  // 2. Generate invoice number (INV-YYYY-SEQ — canonical format)
  const ownerType = account_id ? 'account' as const : 'contact' as const
  const ownerId = (account_id || contact_id)!
  const invoiceNumber = await generateInvoiceNumber(ownerId, ownerType)

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

  // 4. Create client_invoices record (PRIMARY)
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

  // 6. Create payments record (TRACKING) with FK link
  const { data: payment, error: payErr } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
      portal_invoice_id: invoice.id,   // FK link
      invoice_number: invoiceNumber,    // Same INV number (not TD-YYYY)
      description: items[0]?.description || 'Invoice',
      amount: total,
      amount_paid: effectiveAmountPaid,
      amount_due: effectiveAmountDue,
      amount_currency: currency,
      subtotal,
      discount: 0,
      total,
      status: mark_as_paid ? 'Paid' : (effectiveAmountPaid > 0 && effectiveAmountPaid < total ? 'Partial' : 'Pending'),
      invoice_status: status,
      issue_date: today,
      due_date: due_date || null,
      paid_date: paidDateVal,
      payment_date: paidDateVal || today,
      payment_type: 'Invoice',
      payment_method: payment_method || null,
      whop_payment_id: whop_payment_id || null,
      notes: `Portal invoice ${invoiceNumber}`,
      qb_sync_status: 'pending',
    })
    .select('id')
    .single()

  if (payErr || !payment) {
    // Invoice was created but payment mirror failed — log but don't fail
    console.error(`[unified-invoice] payments mirror failed for ${invoiceNumber}: ${payErr?.message}`)
    return {
      invoiceId: invoice.id,
      paymentId: '',
      invoiceNumber,
      total,
      status,
    }
  }

  // 7. Add payment_items mirror
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

  // 8. Audit trail
  logInvoiceAudit({
    invoice_id: invoice.id,
    action: 'created',
    new_values: { invoice_number: invoiceNumber, total, status, currency, tax_total: taxTotal },
    performed_by: 'system',
  })

  return {
    invoiceId: invoice.id,
    paymentId: payment.id,
    invoiceNumber,
    total,
    status,
  }
}

// ─── Bidirectional Status Sync ──────────────────────────

/**
 * Sync status between client_invoices and payments.
 * Call this whenever either record's status changes.
 *
 * source='invoice' → updates client_invoices first, then finds linked payment
 * source='payment' → updates payment first, then finds linked client_invoice
 */
export async function syncInvoiceStatus(
  source: 'invoice' | 'payment',
  id: string,
  newStatus: string,
  paidDate?: string,
  amountPaid?: number
): Promise<{ synced: boolean; linkedId?: string }> {
  const statusMap: Record<string, string> = {
    // client_invoices status → payments status
    'Draft': 'Pending',
    'Sent': 'Pending',
    'Paid': 'Paid',
    'Partial': 'Partial',
    'Split': 'Split',
    'Overdue': 'Overdue',
    'Cancelled': 'Cancelled',
    // payments status → client_invoices status (reverse)
    'Pending': 'Sent',  // best-effort mapping
  }

  // If amountPaid is provided, calculate partial payment status
  if (amountPaid !== undefined) {
    // Resolve the invoice ID to get the invoice total and current amount_paid
    let invoiceId: string | null = null

    if (source === 'invoice') {
      invoiceId = id
    } else {
      const { data: payRec } = await supabaseAdmin
        .from('payments')
        .select('portal_invoice_id')
        .eq('id', id)
        .single()
      invoiceId = payRec?.portal_invoice_id || null
    }

    if (invoiceId) {
      const { data: inv } = await supabaseAdmin
        .from('client_invoices')
        .select('total, amount_paid')
        .eq('id', invoiceId)
        .single()

      if (inv) {
        const currentAmountPaid = Number(inv.amount_paid) || 0
        const newAmountPaid = currentAmountPaid + amountPaid
        const total = Number(inv.total)
        const newAmountDue = Math.max(total - newAmountPaid, 0)

        // Determine status based on payment amount
        if (newAmountDue <= 0) {
          newStatus = 'Paid'
        } else if (newAmountPaid > 0) {
          newStatus = 'Partial'
        }

        // Update client_invoices with partial payment fields
        const invUpdates: Record<string, unknown> = {
          status: newStatus,
          amount_paid: newAmountPaid,
          amount_due: newAmountDue,
          updated_at: new Date().toISOString(),
        }
        if (paidDate) invUpdates.paid_date = paidDate
        await supabaseAdmin.from('client_invoices').update(invUpdates).eq('id', invoiceId)

        // Audit trail
        logInvoiceAudit({
          invoice_id: invoiceId,
          action: newStatus === 'Paid' ? 'paid' : 'partial_payment',
          previous_values: { amount_paid: currentAmountPaid, status: currentAmountPaid > 0 ? 'Partial' : 'Sent' },
          new_values: { amount_paid: newAmountPaid, amount_due: newAmountDue, status: newStatus },
          performed_by: source === 'invoice' ? 'system' : 'auto-reconcile',
        })

        // Update linked payment record
        const paymentStatus = statusMap[newStatus] || newStatus
        if (source === 'invoice') {
          const { data: linkedPay } = await supabaseAdmin
            .from('payments')
            .select('id')
            .eq('portal_invoice_id', invoiceId)
            .limit(1)
            .maybeSingle()
          if (linkedPay) {
            const payUpdates: Record<string, unknown> = {
              status: paymentStatus,
              invoice_status: newStatus,
              amount_paid: newAmountPaid,
              amount_due: newAmountDue,
              updated_at: new Date().toISOString(),
            }
            if (paidDate) payUpdates.paid_date = paidDate
            await supabaseAdmin.from('payments').update(payUpdates).eq('id', linkedPay.id)

            // Check if this is a child of a split invoice
            await checkParentCompletion(invoiceId)
            return { synced: true, linkedId: linkedPay.id }
          }
        } else {
          const payUpdates: Record<string, unknown> = {
            status: paymentStatus,
            invoice_status: newStatus,
            amount_paid: newAmountPaid,
            amount_due: newAmountDue,
            updated_at: new Date().toISOString(),
          }
          if (paidDate) payUpdates.paid_date = paidDate
          await supabaseAdmin.from('payments').update(payUpdates).eq('id', id)

          // Check if this is a child of a split invoice
          await checkParentCompletion(invoiceId)
          return { synced: true, linkedId: invoiceId }
        }

        // Check if this is a child of a split invoice
        await checkParentCompletion(invoiceId)
        return { synced: true }
      }
    }
  }

  // Original behavior (no amountPaid — simple status change)
  const updates: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  }
  if (paidDate) updates.paid_date = paidDate

  if (source === 'invoice') {
    // Update client_invoices
    await supabaseAdmin
      .from('client_invoices')
      .update(updates)
      .eq('id', id)

    // Audit trail
    logInvoiceAudit({
      invoice_id: id,
      action: newStatus === 'Paid' ? 'paid' : 'status_changed',
      new_values: { status: newStatus, ...(paidDate ? { paid_date: paidDate } : {}) },
      performed_by: 'system',
    })

    // Find linked payment via portal_invoice_id
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('portal_invoice_id', id)
      .limit(1)
      .maybeSingle()

    if (payment) {
      const paymentStatus = statusMap[newStatus] || newStatus
      const payUpdates: Record<string, unknown> = {
        status: paymentStatus,
        invoice_status: newStatus,
        updated_at: new Date().toISOString(),
      }
      if (paidDate) payUpdates.paid_date = paidDate
      await supabaseAdmin.from('payments').update(payUpdates).eq('id', payment.id)

      // Check if this is a child of a split invoice
      if (newStatus === 'Paid') await checkParentCompletion(id)
      return { synced: true, linkedId: payment.id }
    }

    if (newStatus === 'Paid') await checkParentCompletion(id)
    return { synced: false }
  } else {
    // source === 'payment'
    // Update payments
    const payUpdates: Record<string, unknown> = {
      ...updates,
      invoice_status: newStatus,
    }
    await supabaseAdmin.from('payments').update(payUpdates).eq('id', id)

    // Find linked client_invoice via portal_invoice_id on this payment
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('portal_invoice_id')
      .eq('id', id)
      .single()

    if (payment?.portal_invoice_id) {
      const invoiceStatus = (newStatus === 'Pending') ? 'Sent' : newStatus
      const invUpdates: Record<string, unknown> = {
        status: invoiceStatus,
        updated_at: new Date().toISOString(),
      }
      if (paidDate) invUpdates.paid_date = paidDate
      await supabaseAdmin.from('client_invoices').update(invUpdates).eq('id', payment.portal_invoice_id)

      // Audit trail
      logInvoiceAudit({
        invoice_id: payment.portal_invoice_id,
        action: invoiceStatus === 'Paid' ? 'paid' : 'status_changed',
        new_values: { status: invoiceStatus, ...(paidDate ? { paid_date: paidDate } : {}) },
        performed_by: 'auto-reconcile',
      })

      // Check if this is a child of a split invoice
      if (newStatus === 'Paid') await checkParentCompletion(payment.portal_invoice_id)
      return { synced: true, linkedId: payment.portal_invoice_id }
    }
    return { synced: false }
  }
}

// ─── Parent Completion Check (Split Invoices) ─────────

/**
 * When a child invoice of a split is marked Paid,
 * check if ALL children are Paid → mark parent as Paid too.
 */
async function checkParentCompletion(invoiceId: string): Promise<void> {
  // Get the invoice to check if it has a parent
  const { data: inv } = await supabaseAdmin
    .from('client_invoices')
    .select('parent_invoice_id')
    .eq('id', invoiceId)
    .single()

  if (!inv?.parent_invoice_id) return

  // Check all children of the parent
  const { data: children } = await supabaseAdmin
    .from('client_invoices')
    .select('status')
    .eq('parent_invoice_id', inv.parent_invoice_id)

  if (children?.length && children.every(c => c.status === 'Paid')) {
    const today = new Date().toISOString().split('T')[0]

    // Fetch parent total so we can set amount_paid = total, amount_due = 0
    const { data: parentInv } = await supabaseAdmin
      .from('client_invoices')
      .select('total')
      .eq('id', inv.parent_invoice_id)
      .single()
    const parentTotal = parentInv ? Number(parentInv.total) : 0

    // All children paid — mark parent as Paid with correct amounts
    const parentUpdates: Record<string, unknown> = {
      status: 'Paid',
      amount_paid: parentTotal,
      amount_due: 0,
      paid_date: today,
      updated_at: new Date().toISOString(),
    }
    await supabaseAdmin.from('client_invoices').update(parentUpdates).eq('id', inv.parent_invoice_id)

    // Also update linked payment
    const { data: linkedPay } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('portal_invoice_id', inv.parent_invoice_id)
      .limit(1)
      .maybeSingle()
    if (linkedPay) {
      await supabaseAdmin.from('payments').update({
        status: 'Paid',
        invoice_status: 'Paid',
        amount_paid: parentTotal,
        amount_due: 0,
        paid_date: today,
        updated_at: new Date().toISOString(),
      }).eq('id', linkedPay.id)
    }
  }
}

// ─── Internal Helpers ───────────────────────────────────

async function resolveCustomerId(accountId?: string, contactId?: string): Promise<string> {
  const matchCol = accountId ? 'account_id' : 'contact_id'
  const matchVal = accountId || contactId

  // Try to find existing customer
  const { data: existing } = await supabaseAdmin
    .from('client_customers')
    .select('id')
    .eq(matchCol, matchVal!)
    .limit(1)
    .maybeSingle()

  if (existing) return existing.id

  // Resolve name/email for new customer
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

  // Create customer
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
