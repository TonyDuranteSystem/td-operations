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

// ─── Types ──────────────────────────────────────────────

export interface UnifiedInvoiceInput {
  account_id?: string
  contact_id?: string
  customer_id?: string  // client_customers.id — resolved internally if not provided
  line_items: Array<{
    description: string
    unit_price: number
    quantity?: number
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

  // 3. Calculate totals
  const items = line_items.map((item) => ({
    description: item.description,
    unit_price: item.unit_price,
    quantity: item.quantity || 1,
    amount: item.unit_price * (item.quantity || 1),
  }))
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0)
  const total = subtotal

  const status = mark_as_paid ? 'Paid' : 'Draft'
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
      total,
      issue_date: today,
      due_date: due_date || null,
      paid_date: paidDateVal,
      notes: notes || null,
      message: message || null,
      recurring_frequency: recurring_frequency || null,
      recurring_end_date: recurring_end_date || null,
      recurring_parent_id: recurring_parent_id || null,
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
      amount_currency: currency,
      subtotal,
      discount: 0,
      total,
      status: mark_as_paid ? 'Paid' : 'Pending',
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
  paidDate?: string
): Promise<{ synced: boolean; linkedId?: string }> {
  const statusMap: Record<string, string> = {
    // client_invoices status → payments status
    'Draft': 'Pending',
    'Sent': 'Pending',
    'Paid': 'Paid',
    'Overdue': 'Overdue',
    'Cancelled': 'Cancelled',
    // payments status → client_invoices status (reverse)
    'Pending': 'Sent',  // best-effort mapping
  }

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
      return { synced: true, linkedId: payment.id }
    }
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
      return { synced: true, linkedId: payment.portal_invoice_id }
    }
    return { synced: false }
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
