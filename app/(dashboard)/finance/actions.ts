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
  payment_method?: 'bank_transfer' | 'card' | 'both'
  bank_preference?: 'auto' | 'relay' | 'mercury' | 'revolut' | 'airwallex'
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order: number }>
  mark_as_paid?: boolean
}): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  return safeAction(async () => {
    const { createTDInvoice } = await import('@/lib/portal/td-invoice')
    const { getBankDetailsByPreference } = await import('@/app/offer/[token]/contract/bank-defaults')

    // Resolve bank details from preference
    const bankPref = input.bank_preference || 'auto'
    const bankDetails = getBankDetailsByPreference(bankPref, input.currency)
    const bankLabel = bankPref === 'auto'
      ? (input.currency === 'EUR' ? 'Airwallex (EUR)' : 'Relay (USD)')
      : bankPref.charAt(0).toUpperCase() + bankPref.slice(1)

    // Build payment instructions for the message field
    const paymentMethod = input.payment_method || 'both'
    let paymentInstructions = ''
    if (paymentMethod === 'bank_transfer' || paymentMethod === 'both') {
      if (bankDetails.iban) {
        paymentInstructions += `\n\nBank Transfer:\nBeneficiary: ${bankDetails.beneficiary}\nIBAN: ${bankDetails.iban}\nBIC: ${bankDetails.bic}\nBank: ${bankDetails.bank_name}`
      } else if (bankDetails.account_number) {
        paymentInstructions += `\n\nBank Transfer:\nBeneficiary: ${bankDetails.beneficiary}\nAccount: ${bankDetails.account_number}\nRouting: ${bankDetails.routing_number}\nBank: ${bankDetails.bank_name}`
      }
    }
    if (paymentMethod === 'card' || paymentMethod === 'both') {
      paymentInstructions += '\n\nCard payment available upon request.'
    }

    const fullMessage = (input.message || '').trim() + paymentInstructions

    const result = await createTDInvoice({
      account_id: input.account_id,
      line_items: input.items.map(item => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: input.currency,
      due_date: input.due_date || undefined,
      message: fullMessage.trim() || undefined,
      payment_method: paymentMethod === 'card' ? 'Card' : paymentMethod === 'bank_transfer' ? `Wire Transfer (${bankLabel})` : `Wire Transfer (${bankLabel}) / Card`,
      bank_preference: bankPref,
      mark_as_paid: input.mark_as_paid || false,
    })

    revalidatePath('/finance')
    revalidatePath('/payments')
    return { id: result.paymentId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: input.account_id,
    summary: `TD invoice created (${input.mark_as_paid ? 'Paid' : 'Draft'}) via CRM dashboard`,
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
    const { error: markPaidErr } = await supabaseAdmin.from('payments').update({
      status: 'Paid',
      invoice_status: 'Paid',
      amount_paid: payment.total,
      amount_due: 0,
      paid_date: today,
      payment_method: paymentMethod || null,
      updated_at: new Date().toISOString(),
    }).eq('id', paymentId)
    if (markPaidErr) throw new Error(`Failed to mark payment as paid: ${markPaidErr.message}`)

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
    const { error: voidErr } = await supabaseAdmin.from('payments').update({
      status: 'Cancelled', invoice_status: 'Cancelled', updated_at: now,
    }).eq('id', paymentId)
    if (voidErr) throw new Error(`Failed to void payment: ${voidErr.message}`)

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
    const { error: bankFeedsErr } = await supabaseAdmin.from('td_bank_feeds').update({
      matched_payment_id: null, match_confidence: null,
      status: 'unmatched', updated_at: now,
    }).eq('matched_payment_id', paymentId)
    if (bankFeedsErr) throw new Error(`Failed to unlink bank feeds: ${bankFeedsErr.message}`)

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice voided/cancelled + QB void + bank feeds unlinked',
  })
}

/**
 * Send a newly created invoice to the client via email.
 *
 * Thin wrapper around sendTDInvoice() (lib/invoice-auto-send.ts) — the single
 * source of truth for sending TD invoices with PDF + HTML. Owns the
 * dashboard-specific contact resolution (flexible: contact_id first, then
 * any account_contacts row — no role filter, unlike the cron path), plus the
 * client_expenses mirror sync and the revalidatePath() calls.
 *
 * The actual PDF generation, HTML rendering, multipart/mixed MIME, bank
 * details resolution (from payments.bank_preference), and payments row
 * update all happen inside sendTDInvoice.
 */
export async function sendNewInvoice(paymentId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, account_id, contact_id')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Payment not found')

    // Dashboard-specific flexible contact resolution:
    //  1. Try payment.contact_id directly (if set)
    //  2. Fall back to ANY account_contacts row (no role filter)
    // This differs from sendTDInvoice's default lookup which uses role='Owner'.
    // Dashboard sends often target a specific contact, so we pre-resolve and
    // pass recipientEmail as an override.
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
    if (!clientEmail) throw new Error('No client email found — check contact record')

    // Delegate to the shared helper. It generates the PDF, builds the HTML
    // body, sends via Gmail with multipart/mixed, and updates payments.
    const { sendTDInvoice } = await import('@/lib/invoice-auto-send')
    await sendTDInvoice(paymentId, { recipientEmail: clientEmail, clientName })

    // Mirror the status change into client_expenses (dashboard-only concern;
    // the cron path doesn't need this because the cron-created payments are
    // already tracked in client_expenses via createTDInvoice).
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Pending')

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice sent to client via email (PDF attached)`,
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

    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const raw = Buffer.from(
      `To: ${clientEmail}\r\nFrom: support@tonydurante.us\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64url')

    await gmailPost('/messages/send', { raw })

    // Update reminder count
    const { error: reminderErr } = await supabaseAdmin.from('payments').update({
      reminder_count: (payment.reminder_count ?? 0) + 1,
      last_reminder_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', paymentId)
    if (reminderErr) throw new Error(`Failed to update reminder count: ${reminderErr.message}`)

    // Mark as Sent if still Draft
    if (status === 'Draft') {
      const { error: sentUpdateErr } = await supabaseAdmin.from('payments').update({
        invoice_status: 'Sent', status: 'Pending', updated_at: new Date().toISOString(),
      }).eq('id', paymentId)
      if (sentUpdateErr) throw new Error(`Failed to mark invoice as sent: ${sentUpdateErr.message}`)
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

    const { error: updatePayErr } = await supabaseAdmin.from('payments').update(payUpdates).eq('id', paymentId)
    if (updatePayErr) throw new Error(`Failed to update invoice: ${updatePayErr.message}`)

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
    const { error: updateExpErr } = await supabaseAdmin.from('client_expenses').update(expUpdates).eq('td_payment_id', paymentId)
    if (updateExpErr) throw new Error(`Failed to sync to client_expenses mirror: ${updateExpErr.message}`)

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
    const { error: ignoreErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'ignored', updated_at: new Date().toISOString() })
      .eq('id', feedId)
    if (ignoreErr) throw new Error(`Failed to ignore bank feed: ${ignoreErr.message}`)
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
