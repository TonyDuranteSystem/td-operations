'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import type { DryRunResult } from '@/lib/operations/destructive'

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
  bank_preference?: string
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order: number }>
  mark_as_paid?: boolean
}): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  return safeAction(async () => {
    const { createTDInvoice } = await import('@/lib/portal/td-invoice')
    const { getBankDetailsByPreference } = await import('@/app/offer/[token]/contract/bank-defaults')

    // Resolve bank details from preference. For settings_bank:<id> values (from the
    // dynamic Invoice Settings dropdown), fall back to 'auto' for the inline payment
    // instructions — the PDF/email bank details are resolved correctly by
    // resolveBankDetails() in invoice-auto-send.ts when the invoice is sent.
    const bankPref = input.bank_preference || 'auto'
    const legacyPrefs = new Set(['auto', 'relay', 'mercury', 'revolut', 'airwallex'])
    const legacyPref = (legacyPrefs.has(bankPref) ? bankPref : 'auto') as 'auto' | 'relay' | 'mercury' | 'revolut' | 'airwallex'
    const bankDetails = getBankDetailsByPreference(legacyPref, input.currency)
    const bankLabel = bankPref === 'auto' || !legacyPrefs.has(bankPref)
      ? (input.currency === 'EUR' ? 'Airwallex (EUR)' : 'Mercury (USD)')
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
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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

/**
 * P3.9 — delete a payment row (works on both invoiced payments and
 * pre-invoice placeholders). Soft-guarded: paid rows are blocked to
 * protect the ledger; any matched bank feeds are unlinked first.
 */
export async function deletePaymentPreview(
  paymentId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, description, amount, total, amount_currency, status, invoice_status, qb_invoice_id, installment')
      .eq('id', paymentId)
      .maybeSingle()

    if (!payment) return { success: false, error: 'Payment not found' }

    const { count: feedCount } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id', { count: 'exact', head: true })
      .eq('matched_payment_id', paymentId)

    const affected: Record<string, number> = {
      payment: 1,
      client_expense_mirror: payment.invoice_number ? 1 : 0,
      matched_bank_feeds: feedCount ?? 0,
    }

    const items: DryRunResult['items'] = [
      {
        label: payment.invoice_number
          ? `Invoice ${payment.invoice_number}`
          : `Pre-invoice placeholder${payment.installment ? ` (${payment.installment})` : ''}`,
        details: [
          `${payment.amount ?? payment.total ?? 0} ${payment.amount_currency ?? ''}`.trim(),
          payment.status ?? 'no status',
          payment.description ?? '',
        ].filter(Boolean),
      },
    ]
    if ((feedCount ?? 0) > 0) {
      items.push({ label: `Unlink ${feedCount} matched bank feed${feedCount === 1 ? '' : 's'}` })
    }
    if (payment.invoice_number) {
      items.push({ label: 'Remove the client_expenses mirror row' })
    }

    const isPaid = payment.status === 'Paid' || payment.invoice_status === 'Paid'

    return {
      success: true,
      preview: {
        affected,
        items,
        warnings: [
          'Delete removes the row — not the same as "void". Use Void on an invoiced row if the client should still see the cancellation.',
        ],
        blocker: isPaid
          ? 'This payment is marked Paid. Deleting a paid ledger entry corrupts history — void it or reverse the payment instead.'
          : undefined,
        record_label: payment.invoice_number ?? 'pre-invoice placeholder',
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

export async function deletePayment(paymentId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, status, invoice_status, account_id')
      .eq('id', paymentId)
      .maybeSingle()
    if (!payment) throw new Error('Payment not found')
    if (payment.status === 'Paid' || payment.invoice_status === 'Paid') {
      throw new Error('Paid payments cannot be deleted — void the invoice instead.')
    }

    // Unlink any matched bank feeds
    // eslint-disable-next-line no-restricted-syntax -- bank_feeds is not a PROTECTED table
    await supabaseAdmin
      .from('td_bank_feeds')
      .update({ matched_payment_id: null, match_confidence: null, status: 'unmatched', updated_at: new Date().toISOString() })
      .eq('matched_payment_id', paymentId)

    // Remove client_expenses mirror if invoiced
    if (payment.invoice_number) {
      await supabaseAdmin
        .from('client_expenses')
        .delete()
        .eq('td_payment_id', paymentId)
    }

    // Delete the payment row itself
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabaseAdmin.from('payments').delete().eq('id', paymentId)
    if (error) throw new Error(`Failed to delete payment: ${error.message}`)

    revalidatePath('/finance')
    revalidatePath('/payments')
    if (payment.account_id) revalidatePath(`/accounts/${payment.account_id}`)
  }, {
    action_type: 'delete',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Payment deleted',
  })
}

/**
 * P3.7: dry-run preview for {@link voidInvoice}. Surfaces what cascades
 * (QB void, bank feed unlink, client_expenses mirror) before the operator
 * confirms the destructive action.
 */
export async function voidInvoicePreview(
  paymentId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, amount, amount_currency, status, qb_invoice_id, description, account_id')
      .eq('id', paymentId)
      .maybeSingle()

    if (!payment) return { success: false, error: 'Invoice not found' }
    if (payment.status === 'Cancelled') {
      return {
        success: true,
        preview: {
          affected: {},
          items: [],
          blocker: 'Invoice is already voided.',
          record_label: payment.invoice_number ?? paymentId,
        },
      }
    }

    const { count: feedCount } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id', { count: 'exact', head: true })
      .eq('matched_payment_id', paymentId)

    const items: DryRunResult['items'] = [
      {
        label: `Mark ${payment.invoice_number ?? 'invoice'} as Cancelled`,
        details: [
          `${payment.amount ?? 0} ${payment.amount_currency ?? ''}`.trim(),
          payment.status ?? 'no status',
        ].filter(Boolean),
      },
    ]
    if (payment.qb_invoice_id) {
      items.push({ label: 'Void corresponding invoice in QuickBooks (best-effort)' })
    }
    items.push({ label: 'Mirror the void into client_expenses' })
    if ((feedCount ?? 0) > 0) {
      items.push({
        label: `Unlink ${feedCount} matched bank feed${feedCount === 1 ? '' : 's'}`,
      })
    }

    return {
      success: true,
      preview: {
        affected: {
          payment: 1,
          qb_invoice: payment.qb_invoice_id ? 1 : 0,
          matched_bank_feeds: feedCount ?? 0,
        },
        items,
        warnings: ['Voiding does not refund the client. Issue a credit note for refunds.'],
        record_label: payment.invoice_number ?? paymentId,
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
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
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
 * source of truth for sending TD invoices with PDF + HTML. Recipient
 * resolution goes through the shared resolvePaymentRecipient() (contact_id →
 * owner-role contact case-insensitive → any linked contact → communication
 * email), plus the client_expenses mirror sync and the revalidatePath() calls.
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

    // Recipient resolution via the single shared resolver: contact_id →
    // owner-role contact (case-insensitive) → any linked contact with an
    // email → account communication_email. Same path as every other
    // invoice-send surface — never hand-roll a role lookup (ADWise incident,
    // 2026-06-18). We pre-resolve and pass recipientEmail as an override so
    // sendTDInvoice uses exactly this recipient.
    const { resolvePaymentRecipient } = await import('@/lib/portal/resolve-payment-recipient')
    const recipient = await resolvePaymentRecipient(
      { contact_id: payment.contact_id, account_id: payment.account_id },
      supabaseAdmin,
    )
    if (!recipient) throw new Error('No client email found — check contact record')
    const clientEmail = recipient.email
    const clientName = recipient.name

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
  // Pre-check: if the invoice is still Draft, delegate to sendNewInvoice so the
  // client receives a real HTML+PDF invoice email (not a plain-text reminder).
  // Root cause of the Apr 2026 "no PDF" incidents (Zhang Holding INV-002040-MNXKCUEJ
  // et al): this function used to double as a "send" for Draft invoices while
  // emailing a plain-text note with no PDF and no bank details.
  const { supabaseAdmin: _adminPre } = await import('@/lib/supabase-admin')
  const { data: preCheck } = await _adminPre
    .from('payments').select('invoice_status').eq('id', paymentId).maybeSingle()
  if (preCheck?.invoice_status === 'Draft') return sendNewInvoice(paymentId)

  return safeAction(async () => {
    // Delegate to the SINGLE shared reminder function (bilingual EN/IT email,
    // shared recipient resolution, reminder_count bump) — same path the dunning
    // cron and the /remind route use. No duplicate plain-text template here.
    const { sendInvoiceReminder: sendReminderEmail } = await import('@/lib/billing/invoice-reminder')
    const result = await sendReminderEmail(paymentId)
    if (!result.ok) throw new Error(result.error ?? 'Failed to send reminder')
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

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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

// Match ONE incoming transaction to MULTIPLE invoices (e.g. a single wire that
// pays invoices for several companies the same person owns). Each selected
// invoice is settled for its own balance; the feed records the full set.
export async function matchBankFeedToInvoices(
  feedId: string,
  paymentIds: string[]
): Promise<ActionResult> {
  return safeAction(async () => {
    const { manualMatchMulti } = await import('@/lib/bank-feed-matcher')
    const result = await manualMatchMulti(feedId, paymentIds)
    if (!result.matched) throw new Error(result.error ?? 'Match failed')
    revalidatePath('/finance')
    revalidatePath('/reconciliation')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: `Multi-match: feed → ${paymentIds.length} invoices`,
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

export async function deleteDuplicateBankFeed(feedId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    // Defensive: verify this row really is a Plaid-Mercury duplicate before deleting.
    // Must be source='mercury' AND have a same-day same-amount mercury_api twin.
    const { data: feed, error: feedErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id, source, transaction_date, amount, currency')
      .eq('id', feedId)
      .maybeSingle()
    if (feedErr) throw new Error(`Failed to read bank feed: ${feedErr.message}`)
    if (!feed) {
      return // Already deleted by another session — treat as success.
    }
    if (feed.source !== 'mercury') {
      throw new Error(`Refusing to delete: feed source is "${feed.source}", expected "mercury"`)
    }
    const { data: twins, error: twinErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id')
      .eq('source', 'mercury_api')
      .eq('transaction_date', feed.transaction_date)
      .eq('amount', feed.amount)
      .eq('currency', feed.currency)
      .limit(1)
    if (twinErr) throw new Error(`Failed to verify twin: ${twinErr.message}`)
    if (!twins || twins.length === 0) {
      throw new Error('Refusing to delete: no mercury_api twin found for this row')
    }

    const { error: delErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .delete()
      .eq('id', feedId)
    if (delErr) throw new Error(`Failed to delete duplicate: ${delErr.message}`)

    revalidatePath('/finance')
    revalidatePath('/reconciliation')
  }, {
    action_type: 'delete',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: `Plaid-Mercury duplicate deleted (feed ${feedId})`,
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

// ── Relink payment ──

export async function unlinkPayment(paymentId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const now = new Date().toISOString()

    // Fetch current total so we can restore amount_due
    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('total')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Invoice not found')

    // Clear bank feed match if one exists
    // eslint-disable-next-line no-restricted-syntax -- unlink requires raw update on td_bank_feeds
    await supabaseAdmin
      .from('td_bank_feeds')
      .update({
        matched_payment_id: null,
        match_confidence: null,
        matched_at: null,
        matched_by: null,
        status: 'unmatched',
        updated_at: now,
      })
      .eq('matched_payment_id', paymentId)

    // Revert invoice to Draft
    // eslint-disable-next-line no-restricted-syntax -- revert invoice status after unlink
    const { error } = await supabaseAdmin
      .from('payments')
      .update({
        invoice_status: 'Draft',
        status: 'Pending',
        paid_date: null,
        amount_paid: 0,
        amount_due: payment.total,
        updated_at: now,
      })
      .eq('id', paymentId)
    if (error) throw new Error(`Failed to revert invoice: ${error.message}`)

    // Sync client_expenses mirror
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Draft')

    revalidatePath('/finance')
    revalidatePath('/accounts')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice unlinked from bank payment — reverted to Draft`,
  })
}
