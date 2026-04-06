'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create a TD LLC invoice TO a client (writes to payments + client_expenses).
 * Staff creates these from the CRM dashboard.
 */
export async function createUnifiedInvoiceDraft(input: {
  account_id: string
  description: string
  currency: 'USD' | 'EUR'
  due_date?: string
  message?: string
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order: number }>
}): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  return safeAction(async () => {
    const { createTDInvoice } = await import('@/lib/portal/td-invoice')

    const result = await createTDInvoice({
      account_id: input.account_id,
      line_items: input.items.map(item => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: input.currency,
      due_date: input.due_date || undefined,
      message: input.message || undefined,
    })

    revalidatePath('/finance')
    revalidatePath('/payments')
    return { id: result.paymentId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: input.account_id,
    summary: `TD invoice created (Draft) via CRM dashboard`,
  })
}

// ── Invoice actions (operate on payments table directly — source of truth for TD billing) ──

export async function markInvoicePaid(
  paymentId: string,
  paymentMethod?: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, total, account_id')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Payment not found')

    const today = new Date().toISOString().split('T')[0]

    // Update payment record
    await supabaseAdmin.from('payments').update({
      status: 'Paid',
      invoice_status: 'Paid',
      amount_paid: payment.total,
      amount_due: 0,
      paid_date: today,
      payment_method: paymentMethod || null,
      updated_at: new Date().toISOString(),
    }).eq('id', paymentId)

    // Sync to client_expenses (portal mirror)
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Paid', today, Number(payment.total))

    // QB sync (non-blocking)
    try {
      const { syncPaymentToQB } = await import('@/lib/qb-sync')
      syncPaymentToQB(paymentId, { paymentDate: today }).catch(() => {})
    } catch { /* QB sync not critical */ }

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice marked as Paid${paymentMethod ? ` (${paymentMethod})` : ''}`,
  })
}

export async function voidInvoice(paymentId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const now = new Date().toISOString()

    // Get payment for QB void
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, qb_invoice_id')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Payment not found')

    // Update payment
    await supabaseAdmin.from('payments').update({
      status: 'Cancelled', invoice_status: 'Cancelled', updated_at: now,
    }).eq('id', paymentId)

    // Sync to client_expenses
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Cancelled')

    // Void in QuickBooks (non-blocking)
    if (payment.qb_invoice_id) {
      try {
        const { syncVoidToQB } = await import('@/lib/qb-sync')
        syncVoidToQB(paymentId).catch(() => {})
      } catch { /* QB not critical */ }
    }

    // Unlink any matched bank feeds
    await supabaseAdmin.from('td_bank_feeds').update({
      matched_payment_id: null, match_confidence: null,
      status: 'unmatched', updated_at: now,
    }).eq('matched_payment_id', paymentId)

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice voided/cancelled + QB void + bank feeds unlinked',
  })
}

export async function sendInvoiceReminder(paymentId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    // Get payment + resolve client email from contact/account
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, total, amount_due, amount_currency, invoice_status, due_date, account_id, contact_id, reminder_count')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Payment not found')

    // Resolve client email from contact (primary) or account
    let clientEmail = ''
    let clientName = ''
    if (payment.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name, email')
        .eq('id', payment.contact_id)
        .single()
      if (contact) { clientName = contact.full_name; clientEmail = contact.email || '' }
    }
    if (!clientEmail && payment.account_id) {
      const { data: link } = await supabaseAdmin
        .from('account_contacts')
        .select('contacts(full_name, email)')
        .eq('account_id', payment.account_id)
        .limit(1)
        .maybeSingle()
      if (link) {
        const c = link.contacts as unknown as { full_name: string; email: string }
        clientName = c.full_name; clientEmail = c.email || ''
      }
    }
    if (!clientEmail) throw new Error('No client email found')

    const currency = payment.amount_currency ?? 'USD'
    const csym = currency === 'EUR' ? '€' : '$'
    const amount = Number(payment.amount_due ?? payment.total)
    const status = payment.invoice_status ?? 'Sent'

    // Send reminder email via Gmail API
    const { gmailPost } = await import('@/lib/gmail')
    const subject = `Payment Reminder: Invoice ${payment.invoice_number} — ${csym}${amount.toLocaleString()}`
    const body = `Dear ${clientName},\n\nThis is a friendly reminder that invoice ${payment.invoice_number} for ${csym}${amount.toLocaleString()} is ${status === 'Overdue' ? 'overdue' : 'due'}${payment.due_date ? ` (due date: ${payment.due_date})` : ''}.\n\nPlease arrange payment at your earliest convenience.\n\nBest regards,\nTony Durante LLC`

    const raw = Buffer.from(
      `To: ${clientEmail}\r\nFrom: support@tonydurante.us\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64url')

    await gmailPost('/messages/send', { raw })

    // Update reminder count
    await supabaseAdmin.from('payments').update({
      reminder_count: (payment.reminder_count ?? 0) + 1,
      last_reminder_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', paymentId)

    // Mark as Sent if still Draft
    if (status === 'Draft') {
      await supabaseAdmin.from('payments').update({
        invoice_status: 'Sent', status: 'Pending', updated_at: new Date().toISOString(),
      }).eq('id', paymentId)
      // Sync to client_expenses
      const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
      await syncTDInvoiceStatus(paymentId, 'Sent')
    }

    revalidatePath('/finance')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice reminder sent`,
  })
}

export async function updateInvoice(
  paymentId: string,
  updates: { description?: string; due_date?: string; notes?: string; message?: string; total?: number }
): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const now = new Date().toISOString()

    // Update payments directly
    const payUpdates: Record<string, unknown> = { updated_at: now }
    if (updates.description !== undefined) payUpdates.description = updates.description
    if (updates.due_date !== undefined) payUpdates.due_date = updates.due_date || null
    if (updates.notes !== undefined) payUpdates.notes = updates.notes || null
    if (updates.message !== undefined) payUpdates.message = updates.message
    if (updates.total !== undefined) {
      payUpdates.total = updates.total
      payUpdates.amount = updates.total
      payUpdates.subtotal = updates.total
      payUpdates.amount_due = updates.total
    }

    await supabaseAdmin.from('payments').update(payUpdates).eq('id', paymentId)

    // Re-sync to QB if amount changed (non-blocking)
    if (updates.total !== undefined) {
      const { data: pay } = await supabaseAdmin.from('payments').select('qb_invoice_id').eq('id', paymentId).single()
      if (pay?.qb_invoice_id) {
        try {
          const { syncInvoiceToQB } = await import('@/lib/qb-sync')
          syncInvoiceToQB(paymentId).catch(() => {})
        } catch { /* QB not critical */ }
      }
    }

    // Also update client_expenses mirror
    const expUpdates: Record<string, unknown> = { updated_at: now }
    if (updates.due_date !== undefined) expUpdates.due_date = updates.due_date || null
    if (updates.total !== undefined) { expUpdates.total = updates.total; expUpdates.subtotal = updates.total }
    if (updates.notes !== undefined) expUpdates.notes = updates.notes
    if (updates.description !== undefined) expUpdates.description = updates.description
    await supabaseAdmin.from('client_expenses').update(expUpdates).eq('td_payment_id', paymentId)

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice updated: ${Object.keys(updates).join(', ')}`,
  })
}

// ── Bank Feed actions ──

export async function matchBankFeedToInvoice(
  feedId: string,
  paymentId: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const { manualMatch } = await import('@/lib/bank-feed-matcher')
    const result = await manualMatch(feedId, paymentId)
    if (!result.matched) throw new Error(result.error ?? 'Match failed')
    revalidatePath('/finance')
    revalidatePath('/reconciliation')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: `Manual match: feed → payment ${paymentId}`,
  })
}

export async function ignoreBankFeed(feedId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'ignored', updated_at: new Date().toISOString() })
      .eq('id', feedId)
    revalidatePath('/finance')
    revalidatePath('/reconciliation')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: 'Bank feed ignored',
  })
}

export async function syncBankFeeds(): Promise<ActionResult> {
  return safeAction(async () => {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/plaid/accounts`, {
      method: 'GET',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error('Plaid sync failed')
    revalidatePath('/finance')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    summary: 'Triggered bank feed sync via Plaid',
  })
}
