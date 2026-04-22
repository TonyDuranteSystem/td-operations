'use server'

import { createClient } from '@/lib/supabase/server'
import { INTERNAL_BASE_URL } from '@/lib/config'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import {
  createInvoiceSchema,
  createCreditNoteSchema,
  type CreateInvoiceInput,
  type CreateCreditNoteInput,
} from '@/lib/schemas/invoice'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { createHash } from 'crypto'

// Stable content hash for idempotency keys on manual CRM invoice creation.
// Two clicks of "Create Invoice" with identical inputs produce the same key,
// so the second click returns the first invoice instead of creating a duplicate.
// Per Antonio: the invoice can be EDITED (keep same number, same client) or VOIDED,
// but never duplicated.
function manualInvoiceIdempotencyKey(
  prefix: 'manual-crm-invoice' | 'manual-crm-credit-note',
  accountId: string,
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number }>,
  description: string,
  total: number,
  currency: string,
  issueDate: string,
): string {
  const sortedItems = [...items].sort((a, b) =>
    `${a.description}|${a.unit_price}|${a.quantity}`.localeCompare(`${b.description}|${b.unit_price}|${b.quantity}`)
  )
  const payload = JSON.stringify({ accountId, description, sortedItems, total, currency, issueDate })
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 16)
  return `${prefix}:${accountId}:${hash}`
}

// ── Create Invoice (Draft) ─────────────────────────────────────────

export async function createInvoice(
  input: CreateInvoiceInput
): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  const parsed = createInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { items, ...invoiceData } = parsed.data
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const total = subtotal - (invoiceData.discount || 0)

  const idempotencyKey = manualInvoiceIdempotencyKey(
    'manual-crm-invoice',
    invoiceData.account_id,
    items,
    invoiceData.description,
    total,
    invoiceData.amount_currency,
    invoiceData.issue_date,
  )

  return safeAction(async () => {
    const result = await createTDInvoice({
      account_id: invoiceData.account_id,
      line_items: items.map((item) => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: invoiceData.amount_currency as 'USD' | 'EUR',
      due_date: invoiceData.due_date || undefined,
      message: invoiceData.message || undefined,
      idempotency_key: idempotencyKey,
    })

    // Override description + billing_entity_id (createTDInvoice sets description
    // from first line item; staff form lets them set both explicitly).
    const supabase = createClient()
    // eslint-disable-next-line no-restricted-syntax -- post-createTDInvoice field override; createTDInvoice doesn't accept description/billing_entity_id/discount as inputs. Acceptable shape until those flow into the helper signature.
    await supabase
      .from('payments')
      .update({
        description: invoiceData.description,
        billing_entity_id: invoiceData.billing_entity_id || null,
        discount: invoiceData.discount || 0,
      })
      .eq('id', result.paymentId)

    revalidatePath('/payments')
    return { id: result.paymentId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: invoiceData.account_id,
    summary: `Invoice created (Draft)`,
    details: { total, currency: invoiceData.amount_currency, items_count: items.length },
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

    // Update payment record (Draft status already verified above — no optimistic lock needed)
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
      updated_at: new Date().toISOString(),
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; pre-existing draft-only update path; tracked by dev_task 7ebb1e0c
    const { error: updateErr } = await supabase
      .from('payments')
      .update(updates)
      .eq('id', paymentId)
      .eq('invoice_status', 'Draft')

    if (updateErr) throw new Error(updateErr.message)

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
  _updatedAt: string,
  paymentMethod?: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    const today = new Date().toISOString().split('T')[0]
    const updates: Record<string, unknown> = {
      status: 'Paid',
      invoice_status: 'Paid',
      paid_date: today,
      updated_at: new Date().toISOString(),
    }
    if (paymentMethod) updates.payment_method = paymentMethod

    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
    const { error } = await supabase
      .from('payments')
      .update(updates)
      .eq('id', paymentId)
      .in('invoice_status', ['Sent', 'Overdue'])

    if (error) throw new Error(error.message)

    // Fire-and-forget receipt email — must not block the Paid transition.
    import('@/lib/invoice-auto-send').then(({ sendPaidReceipt }) =>
      sendPaidReceipt(paymentId).catch((err) =>
        console.error('[markInvoicePaid] receipt send failed:', err),
      ),
    )

    // QB sync removed — QB is now one-way manual via the CRM finance "Push to QuickBooks" button.

    // Check if this invoice is linked to a pending_activation → trigger activation chain
    const adminSupabase = (await import('@/lib/supabase-admin')).supabaseAdmin
    const { data: pendingAct } = await adminSupabase
      .from('pending_activations')
      .select('id, status')
      .eq('portal_invoice_id', paymentId)
      .eq('status', 'awaiting_payment')
      .maybeSingle()

    if (pendingAct) {
      await adminSupabase
        .from('pending_activations')
        .update({
          status: 'payment_confirmed',
          payment_confirmed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', pendingAct.id)

      // Trigger activate-service (non-blocking)
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || INTERNAL_BASE_URL
      fetch(`${baseUrl}/api/workflows/activate-service`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.API_SECRET_TOKEN}`,
        },
        body: JSON.stringify({ pending_activation_id: pendingAct.id }),
      }).catch(() => {})
    }

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
  _updatedAt: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()
    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
    const { error } = await supabase
      .from('payments')
      .update({
        invoice_status: 'Voided',
        status: 'Waived',
        updated_at: new Date().toISOString(),
      })
      .eq('id', paymentId)
      .in('invoice_status', ['Draft', 'Sent', 'Overdue'])

    if (error) throw new Error(error.message)

    // QB sync removed — QB is now one-way manual via the CRM finance "Push to QuickBooks" button.

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

  // Idempotency key: if linked to a source payment, the (account, source) tuple
  // dedupes. Otherwise hash on items.
  const idempotencyKey = noteData.credit_for_payment_id
    ? `manual-crm-credit-note:${noteData.account_id}:src:${noteData.credit_for_payment_id}`
    : manualInvoiceIdempotencyKey(
        'manual-crm-credit-note',
        noteData.account_id,
        items.map((it) => ({ ...it, unit_price: -Math.abs(it.unit_price), amount: -Math.abs(it.amount) })),
        noteData.description,
        total,
        noteData.amount_currency,
        noteData.issue_date,
      )

  return safeAction(async () => {
    const result = await createTDInvoice({
      account_id: noteData.account_id,
      line_items: items.map((item) => ({
        description: item.description,
        unit_price: -Math.abs(item.unit_price),
        quantity: item.quantity,
      })),
      currency: noteData.amount_currency as 'USD' | 'EUR',
      mark_as_paid: true,
      paid_date: noteData.issue_date,
      idempotency_key: idempotencyKey,
    })

    // Override credit-note-specific fields (createTDInvoice doesn't know about
    // credit semantics — it sees this as a normal invoice with negative total).
    const supabase = createClient()
    // eslint-disable-next-line no-restricted-syntax -- post-createTDInvoice override of credit-note-specific fields not in helper signature.
    await supabase
      .from('payments')
      .update({
        description: noteData.description,
        invoice_status: 'Credit',
        credit_for_payment_id: noteData.credit_for_payment_id || null,
        referral_partner_id: noteData.referral_partner_id || null,
      })
      .eq('id', result.paymentId)

    revalidatePath('/payments')
    return { id: result.paymentId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: noteData.account_id,
    summary: `Credit note created`,
    details: { total, referral_partner_id: noteData.referral_partner_id },
  })
}

// ── Delete Invoice (Draft only) ─────────────────────────────────────

export async function deleteInvoice(
  paymentId: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const supabase = createClient()

    // Verify still Draft
    const { data: current } = await supabase
      .from('payments')
      .select('invoice_status, invoice_number')
      .eq('id', paymentId)
      .single()

    if (!current) throw new Error('Invoice not found')
    if (current.invoice_status !== 'Draft') {
      throw new Error('Can only delete Draft invoices. Void it instead.')
    }

    // Delete items first (FK cascade should handle this, but be explicit)
    await supabase.from('payment_items').delete().eq('payment_id', paymentId)

    // Delete payment
    const { error } = await supabase.from('payments').delete().eq('id', paymentId)
    if (error) throw new Error(error.message)

    revalidatePath('/payments')
  }, {
    action_type: 'delete',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice deleted',
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
