'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create an invoice via the unified system (writes to BOTH client_invoices + payments).
 * This replaces the old createInvoice from payments/invoice-actions.ts which only wrote to payments.
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
    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')

    const result = await createUnifiedInvoice({
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
    return { id: result.invoiceId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'client_invoices',
    account_id: input.account_id,
    summary: `Invoice created (Draft) via unified system`,
  })
}

// ── Invoice actions ──

export async function markInvoicePaid(
  invoiceId: string,
  paymentMethod?: string
): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { syncInvoiceStatus } = await import('@/lib/portal/unified-invoice')

    // Get the invoice to find linked payment
    const { data: inv } = await supabaseAdmin
      .from('client_invoices')
      .select('id, invoice_number, total, account_id')
      .eq('id', invoiceId)
      .single()
    if (!inv) throw new Error('Invoice not found')

    const today = new Date().toISOString().split('T')[0]

    // Find linked payment
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('portal_invoice_id', invoiceId)
      .limit(1)
      .maybeSingle()

    if (payment) {
      // Use unified sync (updates BOTH client_invoices + payments)
      await syncInvoiceStatus('payment', payment.id, 'Paid', today, Number(inv.total))
      if (paymentMethod) {
        await supabaseAdmin.from('payments').update({ payment_method: paymentMethod }).eq('id', payment.id)
      }
      // QB sync (non-blocking)
      try {
        const { syncPaymentToQB } = await import('@/lib/qb-sync')
        syncPaymentToQB(payment.id, { paymentDate: today }).catch(() => {})
      } catch { /* QB sync not critical */ }
    } else {
      // No linked payment — update client_invoices directly
      await supabaseAdmin.from('client_invoices').update({
        status: 'Paid', paid_date: today, amount_paid: inv.total, amount_due: 0, updated_at: new Date().toISOString(),
      }).eq('id', invoiceId)
    }

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'client_invoices',
    record_id: invoiceId,
    summary: `Invoice marked as Paid${paymentMethod ? ` (${paymentMethod})` : ''}`,
  })
}

export async function voidInvoice(invoiceId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const now = new Date().toISOString()

    await supabaseAdmin.from('client_invoices').update({
      status: 'Cancelled', updated_at: now,
    }).eq('id', invoiceId)

    // Also update linked payment
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id')
      .eq('portal_invoice_id', invoiceId)
      .limit(1)
      .maybeSingle()
    if (payment) {
      await supabaseAdmin.from('payments').update({
        status: 'Cancelled', invoice_status: 'Cancelled', updated_at: now,
      }).eq('id', payment.id)
    }

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'client_invoices',
    record_id: invoiceId,
    summary: 'Invoice voided/cancelled',
  })
}

export async function sendInvoiceReminder(invoiceId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    // Get invoice + customer email
    const { data: inv } = await supabaseAdmin
      .from('client_invoices')
      .select('id, invoice_number, total, currency, amount_due, status, due_date, account_id, contact_id, client_customers!customer_id(email, name)')
      .eq('id', invoiceId)
      .single()
    if (!inv) throw new Error('Invoice not found')

    const customer = inv.client_customers as unknown as { email: string; name: string } | null
    if (!customer?.email) throw new Error('No customer email found')

    // Send reminder email via Gmail API
    const { gmailPost } = await import('@/lib/gmail')
    const subject = `Payment Reminder: Invoice ${inv.invoice_number} — ${inv.currency === 'EUR' ? '€' : '$'}${Number(inv.amount_due ?? inv.total).toLocaleString()}`
    const body = `Dear ${customer.name},\n\nThis is a friendly reminder that invoice ${inv.invoice_number} for ${inv.currency === 'EUR' ? '€' : '$'}${Number(inv.amount_due ?? inv.total).toLocaleString()} is ${inv.status === 'Overdue' ? 'overdue' : 'due'}${inv.due_date ? ` (due date: ${inv.due_date})` : ''}.\n\nPlease arrange payment at your earliest convenience.\n\nBest regards,\nTony Durante LLC`

    // Build RFC 2822 email
    const raw = Buffer.from(
      `To: ${customer.email}\r\nFrom: support@tonydurante.us\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64url')

    await gmailPost('/messages/send', { raw })

    // Update reminder count
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, reminder_count')
      .eq('portal_invoice_id', invoiceId)
      .limit(1)
      .maybeSingle()
    if (payment) {
      await supabaseAdmin.from('payments').update({
        reminder_count: (payment.reminder_count ?? 0) + 1,
        last_reminder_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', payment.id)
    }

    // Mark as Sent if still Draft
    if (inv.status === 'Draft') {
      await supabaseAdmin.from('client_invoices').update({
        status: 'Sent', updated_at: new Date().toISOString(),
      }).eq('id', invoiceId)
    }

    revalidatePath('/finance')
  }, {
    action_type: 'update',
    table_name: 'client_invoices',
    record_id: invoiceId,
    summary: `Invoice reminder sent`,
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
