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
  issue_date?: string
  message?: string
  payment_method?: 'bank_transfer' | 'card' | 'both'
  bank_preference?: string
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order: number }>
  mark_as_paid?: boolean
  /**
   * The New Invoice dialog's installment dropdown was being collected and
   * silently discarded — this function never forwarded it, so an invoice
   * staff explicitly labeled "Installment 2 (Jun)" landed with no
   * payment_category and no year, invisible to the account-page badge, the
   * annual-installments cron's duplicate guard, and this same function's own
   * duplicate check below (2026-08-31, ShoppyVerse LLC investigation).
   */
  installment?: string
}): Promise<ActionResult<{ id: string; invoice_number: string; duplicate_warning?: string }>> {
  return safeAction(async () => {
    const { createTDInvoice } = await import('@/lib/portal/td-invoice')
    const { getBankDetailsByPreference } = await import('@/app/offer/[token]/contract/bank-defaults')
    const { fetchSettingsBanks, selectSettingsBank } = await import('@/lib/invoice-auto-send')

    // Resolve bank details from preference. For settings_bank:<id> values (from the
    // dynamic Invoice Settings dropdown), fall back to 'auto' for the inline payment
    // instructions — the PDF/email bank details are resolved correctly by
    // resolveBankDetails() in invoice-auto-send.ts when the invoice is sent.
    const bankPref = input.bank_preference || 'auto'
    const legacyPrefs = new Set(['auto', 'relay', 'mercury', 'revolut', 'airwallex'])
    const legacyPref = (legacyPrefs.has(bankPref) ? bankPref : 'auto') as 'auto' | 'relay' | 'mercury' | 'revolut' | 'airwallex'
    const bankDetails = getBankDetailsByPreference(legacyPref, input.currency)

    // The label stamped on the invoice (payments.payment_method, e.g. "Wire
    // Transfer (Chase JP Morgan)") must name the SPECIFIC bank picked, not a
    // hardcoded currency-based guess — that guess was always "Mercury (USD)"
    // / "Airwallex (EUR)" regardless of which of the real configured banks
    // was actually selected, found live in production QA (dev job ea5751ef).
    let bankLabel: string
    if (bankPref === 'auto') {
      bankLabel = input.currency === 'EUR' ? 'Airwallex (EUR)' : 'Mercury (USD)'
    } else if (legacyPrefs.has(bankPref)) {
      bankLabel = bankPref.charAt(0).toUpperCase() + bankPref.slice(1)
    } else {
      const banks = await fetchSettingsBanks()
      const selected = selectSettingsBank(bankPref, banks)
      bankLabel = selected
        ? (selected.name || selected.bank_name)
        : (input.currency === 'EUR' ? 'Airwallex (EUR)' : 'Mercury (USD)')
    }

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
      issue_date: input.issue_date,
      message: fullMessage.trim() || undefined,
      payment_method: paymentMethod === 'card' ? 'Card' : paymentMethod === 'bank_transfer' ? `Wire Transfer (${bankLabel})` : `Wire Transfer (${bankLabel}) / Card`,
      bank_preference: bankPref,
      mark_as_paid: input.mark_as_paid || false,
      installment: input.installment || undefined,
      // Derived from the issue date — this dialog has no separate year field.
      // Falls back to the office's own "today" (not the server's UTC clock) to
      // match createTDInvoice's own issue_date default exactly.
      year: input.installment
        ? Number((input.issue_date || (await import('@/lib/portal/office-hours')).getOfficeDateString()).slice(0, 4))
        : undefined,
    })

    revalidatePath('/finance')
    revalidatePath('/payments')
    return { id: result.paymentId, invoice_number: result.invoiceNumber, duplicate_warning: result.duplicate_warning }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: input.account_id,
    summary: `TD invoice created (${input.mark_as_paid ? 'Paid' : 'Draft'}) via CRM dashboard`,
  })
}

// ── Card processing fee — global kill switch (Council-approved Phase A, 2026-07-15) ──

/**
 * Flip the global card-fee switch from the Finance dashboard.
 *
 * OFF = every card payment charges the BASE price (overrides every per-deal 5%
 * pin). ON = each deal's pinned rate applies again. Propagates within ~1 minute
 * (per-instance config cache); payment links already issued keep their price.
 *
 * Admin gate is INSIDE the action — page-level tab visibility is not a
 * security boundary (Council condition). Uses the merge-safe setter, never the
 * generic app-settings PUT (whole-value replace would clobber the stored rate).
 */
export async function toggleCardFee(enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  const { createClient } = await import('@/lib/supabase/server')
  const { isAdmin } = await import('@/lib/auth')
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return { success: false, error: 'Admin access required' }
  }

  return safeAction(async () => {
    const { setCardFeeEnabled } = await import('@/lib/payments/card-fee-config')
    await setCardFeeEnabled(enabled, `finance-ui:${user.email ?? user.id}`)
    revalidatePath('/finance')
    return { enabled }
  }, {
    action_type: 'update',
    table_name: 'app_settings',
    summary: `Card processing fee switched ${enabled ? 'ON' : 'OFF'} from the Finance dashboard`,
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

    // Sync to client_expenses (portal mirror). BOTH calls, status first: syncTDInvoiceStatus
    // maps only the STATUS (and is the sole emitter of the staff "Client paid" note), which is
    // how a mirror ended up reading Paid while still recording the full amount as unpaid —
    // exactly what happened to the Aces invoice on 2026-07-22. syncTDInvoiceMirror is the
    // authoritative projection of the balances.
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Paid', today, Number(payment.total))
    const { syncTDInvoiceMirror } = await import('@/lib/portal/td-invoice-mirror')
    await syncTDInvoiceMirror(paymentId)

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

    // ⛔ A PART-PAID INVOICE STILL HOLDS REAL BANK MONEY. The Paid check above misses it, and
    // `payment_applications.payment_id` cascades ON DELETE — so deleting the row would destroy
    // the record of which transaction paid what, while the freed transaction returns to the
    // matcher at its full amount and can be credited somewhere else. Refuse and make the
    // operator un-match first, which is the deliberate act that goes through the money path.
    const { listConfirmedApplications } = await import('@/lib/finance/apply-payment')
    const applied = await listConfirmedApplications(paymentId)
    if (applied.length > 0) {
      const total = applied.reduce((sum, a) => sum + Number(a.amount ?? 0), 0)
      throw new Error(
        `This invoice has ${total} of bank payments applied to it, so deleting it would lose the record of that money. Un-match the transaction${applied.length > 1 ? 's' : ''} first.`,
      )
    }

    // Unlink any matched bank feeds
    // eslint-disable-next-line no-restricted-syntax -- bank_feeds is not a PROTECTED table
    const { error: unlinkErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ matched_payment_id: null, match_confidence: null, status: 'unmatched', updated_at: new Date().toISOString() })
      .eq('matched_payment_id', paymentId)
    // Checked, not assumed: an unlink that silently failed would leave the transaction
    // pointing at an invoice that no longer exists as this payment.
    if (unlinkErr) throw new Error(`Failed to unlink bank feeds: ${unlinkErr.message}`)

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

/**
 * Cancel (void) an invoice.
 *
 * Records a {@link PreVoidState} snapshot into `action_log.details` so
 * {@link reactivateInvoice} can restore the invoice EXACTLY. Before 2026-07-10
 * this captured nothing, which is why un-cancelling was impossible and the
 * VictoriamRoas INV-002218 repair had to be done by hand.
 */
export async function voidInvoice(paymentId: string): Promise<ActionResult> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const { capturePreVoidState, partitionFeedsForUnlink } = await import('@/lib/billing/invoice-reactivate')

  // Snapshot BEFORE the update, and outside safeAction, so the audit payload
  // describes the pre-void state rather than the post-void one.
  const { data: before } = await supabaseAdmin
    .from('payments')
    .select('id, qb_invoice_id, status, invoice_status, amount_due, amount_paid, paid_date, credit_remaining')
    .eq('id', paymentId)
    .maybeSingle()
  if (!before) return { success: false, error: 'Payment not found' }
  if (before.invoice_status === 'Cancelled' || before.status === 'Cancelled') {
    return { success: false, error: 'This invoice is already cancelled.' }
  }
  const preVoidState = capturePreVoidState(before)

  return safeAction(async () => {
    const now = new Date().toISOString()

    // Update payment
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: voidErr } = await supabaseAdmin.from('payments').update({
      status: 'Cancelled', invoice_status: 'Cancelled', updated_at: now,
      // Free the idempotency slot (gate defect, 2026-08-11 — found by Antonio's real click):
      // this is the THIRD door that marks an invoice dead, and it was the only one still keeping
      // the key. The key is globally unique while present, so a cancelled tranche part blocked
      // its own re-raise with a collision — the corpse-bug's sibling, one file over from where
      // the council fixed it. The cascade and the payments-page void both already release it.
      idempotency_key: null,
    }).eq('id', paymentId)
    if (voidErr) throw new Error(`Failed to void payment: ${voidErr.message}`)

    // Sync to client_expenses. syncTDInvoiceStatus maps the STATUS only — it
    // left the mirror's `amount_due` at the old balance, so the client's portal
    // showed a cancelled invoice still demanding the full amount. Follow it with
    // the authoritative projection, which zeroes a settled balance. (Caught by
    // the live QA harness; the prod VictoriamRoas mirror had exactly this.)
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Cancelled')
    const { syncTDInvoiceMirror } = await import('@/lib/portal/td-invoice-mirror')
    await syncTDInvoiceMirror(paymentId)

    // Void in QuickBooks (non-blocking)
    if (before.qb_invoice_id) {
      try {
        const { syncVoidToQB } = await import('@/lib/qb-sync')
        syncVoidToQB(paymentId).catch(() => {})
      } catch { /* QB not critical */ }
    }

    // Unlink bank feeds. A CONFIRMED `matched` row returns to the review queue
    // (the reconciliation it represented is undone). Every other linked row is
    // only an unconfirmed suggestion — clear its stale pointer but PRESERVE its
    // status, or rows the operator already dismissed (`ignored`) and outgoing
    // transfers (`outgoing`) get resurrected into the queue. Found 2026-07-10.
    const { data: linkedFeeds, error: feedReadErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id, status')
      .eq('matched_payment_id', paymentId)
    if (feedReadErr) throw new Error(`Failed to read bank feeds: ${feedReadErr.message}`)

    // ⛔ A TRANSACTION WHOSE MONEY IS STILL RECORDED HERE MUST NOT BE SET FREE (2026-07-29,
    // Bug-Hunter on the finished code).
    //
    // Voiding deliberately KEEPS `amount_paid` — it is real cash, and reactivating restores it
    // (see resolveReactivateTarget). But the old code also returned every matched transaction
    // to `unmatched`, so the same wire went back to the matcher at its full amount while its
    // money was still recorded against the cancelled invoice. Settle anything else with it and
    // one $1,000 wire is booked as $2,000 — and the per-invoice invariant still holds on both
    // rows, so nothing detects it.
    //
    // So: a transaction that has a CONFIRMED application to this invoice keeps its link and its
    // `matched` status. The money stays attributed to where it actually went, the matcher never
    // sees it again, and a reactivate finds everything exactly as it was. To genuinely release
    // it, un-match the invoice first — the deliberate act that reverses the money.
    const { listConfirmedApplications } = await import('@/lib/finance/apply-payment')
    const fundedFeedIds = new Set((await listConfirmedApplications(paymentId)).map((a) => a.feed_id))
    const releasable = (linkedFeeds ?? []).filter((f) => !fundedFeedIds.has(f.id))

    const { resetIds, clearIds } = partitionFeedsForUnlink(releasable)

    if (resetIds.length > 0) {
      const { error } = await supabaseAdmin.from('td_bank_feeds').update({
        matched_payment_id: null, match_confidence: null, status: 'unmatched', updated_at: now,
      }).in('id', resetIds)
      if (error) throw new Error(`Failed to unlink bank feeds: ${error.message}`)
    }
    if (clearIds.length > 0) {
      const { error } = await supabaseAdmin.from('td_bank_feeds').update({
        matched_payment_id: null, match_confidence: null, updated_at: now,
      }).in('id', clearIds)
      if (error) throw new Error(`Failed to clear bank feed suggestions: ${error.message}`)
    }

    revalidatePath('/finance')
    revalidatePath('/payments')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice voided/cancelled + bank feeds unlinked',
    // Read back by reactivateInvoice. Do not rename this key.
    details: { pre_void_state: preVoidState },
  })
}

/**
 * Dry-run preview for {@link reactivateInvoice}. Its most important job is to
 * warn how many AUTOMATIC chase emails the client will receive the moment this
 * invoice is live again — a long-overdue invoice with no reminders on record
 * satisfies both thresholds at once and fires two emails back-to-back.
 */
export async function reactivateInvoicePreview(
  paymentId: string,
): Promise<{ success: boolean; preview?: DryRunResult; error?: string }> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { parsePreVoidState, resolveReactivateTarget, reactivateBlocker } = await import('@/lib/billing/invoice-reactivate')
    const { projectedReminderCount, daysPastDue, isAutoSendEnabled } = await import('@/lib/billing/dunning')
    const { isAccountReminderPaused } = await import('@/lib/billing/reminder-snooze')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, status, invoice_status, total, amount, amount_due, amount_paid, amount_currency, due_date, sent_at, reminder_count, account_id')
      .eq('id', paymentId)
      .maybeSingle()
    if (!payment) return { success: false, error: 'Invoice not found' }

    const label = payment.invoice_number ?? paymentId

    if (payment.invoice_status !== 'Cancelled' && payment.status !== 'Cancelled') {
      return { success: true, preview: { affected: {}, items: [], blocker: 'This invoice is not cancelled.', record_label: label } }
    }

    const { prior, target } = await resolveTargetFor(payment, supabaseAdmin, parsePreVoidState, resolveReactivateTarget)

    const blocker = reactivateBlocker({
      prior,
      total: Number(payment.total ?? payment.amount ?? 0),
      invoiceStatus: payment.invoice_status,
    })
    if (blocker) return { success: true, preview: { affected: {}, items: [], blocker, record_label: label } }

    const currency = payment.amount_currency ?? ''
    const items: DryRunResult['items'] = [
      {
        label: `Restore ${label} as ${target.invoice_status}`,
        details: [
          `${target.amount_due} ${currency}`.trim() + ' outstanding',
          target.source === 'recorded' ? 'exactly as it was before cancelling' : 'state reconstructed from the invoice',
        ],
      },
      { label: "Restore the client's copy in the portal" },
    ]

    const warnings: string[] = []

    // Will the nightly dunning pass email this client?
    let reminders = 0
    if (payment.due_date && payment.account_id) {
      const [autoSend, accountRes] = await Promise.all([
        isAutoSendEnabled(),
        supabaseAdmin
          .from('accounts')
          .select('dunning_reminder_1_days, dunning_reminder_2_days, dunning_pause, dunning_pause_until')
          .eq('id', payment.account_id)
          .maybeSingle(),
      ])
      // Cast: `dunning_pause_until` exists in the DB but is missing from the
      // generated types (known schema-types drift). Same cast as dunning.ts.
      const account = accountRes.data as unknown as {
        dunning_reminder_1_days: number | null
        dunning_reminder_2_days: number | null
        dunning_pause: boolean | null
        dunning_pause_until: string | null
      } | null
      reminders = projectedReminderCount({
        autoSendEnabled: autoSend,
        accountPaused: account ? isAccountReminderPaused(account) : false,
        invoiceStatus: target.invoice_status,
        daysOverdue: daysPastDue(payment.due_date, new Date().toISOString().split('T')[0]),
        reminderCount: payment.reminder_count ?? 0,
        r1: account?.dunning_reminder_1_days ?? 7,
        r2: account?.dunning_reminder_2_days ?? 14,
      })
    }
    if (reminders > 0) {
      warnings.push(
        `This invoice is already past due, so the client will automatically receive ${reminders} "Payment Overdue" email${reminders === 1 ? '' : 's'} over the next ${reminders === 1 ? 'night' : `${reminders} nights`}. Pause reminders for this client first if that is not what you want.`,
      )
      items.push({ label: `Client receives ${reminders} automatic reminder email${reminders === 1 ? '' : 's'}` })
    }

    if (!payment.sent_at) {
      warnings.push('This invoice was never emailed to the client.')
    }
    warnings.push('Bank transactions unlinked when this invoice was cancelled are NOT relinked. Re-match them from the Bank Feed tab if needed.')

    return {
      success: true,
      preview: { affected: { payment: 1, reminder_emails: reminders }, items, warnings, record_label: label },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Preview failed' }
  }
}

type AdminClient = typeof import('@/lib/supabase-admin')['supabaseAdmin']
type ParsePreVoidState = typeof import('@/lib/billing/invoice-reactivate')['parsePreVoidState']
type ResolveReactivateTarget = typeof import('@/lib/billing/invoice-reactivate')['resolveReactivateTarget']

/** Shared by the preview and the commit so they can never disagree. */
async function resolveTargetFor(
  payment: { id: string; total: number | null; amount: number | null; amount_paid: number | null; due_date: string | null; sent_at: string | null },
  supabaseAdmin: AdminClient,
  parsePreVoidState: ParsePreVoidState,
  resolveReactivateTarget: ResolveReactivateTarget,
) {
  // Most recent void of this invoice carries the snapshot (if it was cancelled
  // after 2026-07-10; older cancellations recorded nothing and fall back to
  // derivation).
  const { data: voidLog } = await supabaseAdmin
    .from('action_log')
    .select('details')
    .eq('table_name', 'payments')
    .eq('record_id', payment.id)
    .order('created_at', { ascending: false })
    .limit(10)

  let prior: ReturnType<ParsePreVoidState> = null
  for (const row of voidLog ?? []) {
    prior = parsePreVoidState((row as { details: unknown }).details)
    if (prior) break
  }

  const target = resolveReactivateTarget({
    prior,
    total: Number(payment.total ?? payment.amount ?? 0),
    amountPaid: Number(payment.amount_paid ?? 0),
    dueDate: payment.due_date,
    today: new Date().toISOString().split('T')[0],
    wasSent: !!payment.sent_at,
  })
  return { prior, target }
}

/**
 * Bring a cancelled invoice back to life — the inverse of {@link voidInvoice}.
 *
 * Restores the exact pre-void state when the cancellation recorded one,
 * otherwise reconstructs the honest state from the invoice (see
 * `resolveReactivateTarget`). Re-syncs the client's portal copy. Deliberately
 * does NOT relink bank transactions: which suggestion was right is not
 * recoverable, and guessing would silently mis-reconcile money.
 */
export async function reactivateInvoice(paymentId: string): Promise<ActionResult<{ invoice_status: string; source: string }>> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const { parsePreVoidState, resolveReactivateTarget, reactivateBlocker } = await import('@/lib/billing/invoice-reactivate')

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, status, invoice_status, total, amount, amount_paid, due_date, sent_at')
    .eq('id', paymentId)
    .maybeSingle()
  if (!payment) return { success: false, error: 'Invoice not found' }
  if (payment.invoice_status !== 'Cancelled' && payment.status !== 'Cancelled') {
    return { success: false, error: 'Only a cancelled invoice can be reactivated.' }
  }

  const { prior, target } = await resolveTargetFor(payment, supabaseAdmin, parsePreVoidState, resolveReactivateTarget)

  const blocker = reactivateBlocker({
    prior,
    total: Number(payment.total ?? payment.amount ?? 0),
    invoiceStatus: payment.invoice_status,
  })
  if (blocker) return { success: false, error: blocker }

  return safeAction(async () => {
    const now = new Date().toISOString()

    const patch: Record<string, unknown> = {
      status: target.status,
      invoice_status: target.invoice_status,
      amount_due: target.amount_due,
      amount_paid: target.amount_paid,
      paid_date: target.paid_date,
      updated_at: now,
    }
    // Only a credit note carries this; never overwrite it with null on an
    // ordinary invoice.
    if (target.credit_remaining !== null) patch.credit_remaining = target.credit_remaining

    // TOCTOU guard: only reactivate if it is STILL cancelled.
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { data: updated, error } = await supabaseAdmin
      .from('payments')
      .update(patch)
      .eq('id', paymentId)
      .eq('invoice_status', 'Cancelled')
      .select('id')
    if (error) throw new Error(`Failed to reactivate invoice: ${error.message}`)
    if (!updated || updated.length === 0) throw new Error('Invoice is no longer cancelled — reload and try again.')

    // Rebuild the client-facing copy from the payment (authoritative projection).
    const { syncTDInvoiceMirror } = await import('@/lib/portal/td-invoice-mirror')
    await syncTDInvoiceMirror(paymentId)

    revalidatePath('/finance')
    revalidatePath('/payments')

    return { invoice_status: target.invoice_status, source: target.source }
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice reactivated as ${target.invoice_status} (${target.source})`,
    details: { reactivated_to: target },
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

export async function sendInvoiceReminder(paymentId: string, opts: { force?: boolean } = {}): Promise<ActionResult> {
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
    // The account-level pause is enforced inside it; `force` is the deliberate
    // staff override coming from the UI's warn-and-confirm dialog.
    const { sendInvoiceReminder: sendReminderEmail } = await import('@/lib/billing/invoice-reminder')
    const result = await sendReminderEmail(paymentId, { source: 'manual', force: opts.force })
    if (result.paused) {
      throw new Error(
        `Reminders are paused for this client${result.pausedUntil ? ` until ${result.pausedUntil}` : ''} — confirm "send anyway" to override`,
      )
    }
    if (!result.ok) throw new Error(result.error ?? 'Failed to send reminder')
    revalidatePath('/finance')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: `Invoice reminder sent`,
  })
}

export interface BulkReminderOutcome {
  id: string
  invoice_number: string
  status: 'sent' | 'skipped' | 'failed'
  reason?: string
  recipient?: string
}

/**
 * Send payment reminders to many invoices in one shot (the Overdue-list bulk
 * button). Cap/pause-aware: skips paused accounts and invoices already at the
 * 2-reminder limit unless `overrideCap` is set. Runs sequentially (Gmail
 * pacing) and reports a per-invoice outcome — never collapses to one toast.
 */
export async function sendBulkReminders(
  paymentIds: string[],
  opts: { overrideCap?: boolean } = {},
): Promise<ActionResult<{ outcomes: BulkReminderOutcome[]; sent: number; skipped: number; failed: number }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { sendInvoiceReminder: sendReminderEmail } = await import('@/lib/billing/invoice-reminder')

    // Dedupe + hard cap the batch size as a safety rail.
    const ids = Array.from(new Set(paymentIds)).slice(0, 200)
    const outcomes: BulkReminderOutcome[] = []

    for (const id of ids) {
      const { data: p } = await supabaseAdmin
        .from('payments')
        .select('id, invoice_number, invoice_status, reminder_count, account_id')
        .eq('id', id)
        .single()
      const invNo = p?.invoice_number ?? id
      if (!p) { outcomes.push({ id, invoice_number: invNo, status: 'failed', reason: 'Invoice not found' }); continue }

      // Per-account dunning pause gate — the boolean pause OR an active dated
      // pause ("client promised to pay by X"). Bulk NEVER overrides a pause;
      // use the single-row "send anyway" flow for a deliberate exception.
      if (p.account_id) {
        const { data: acc } = await supabaseAdmin.from('accounts').select('dunning_pause, dunning_pause_until').eq('id', p.account_id).single()
        const { isAccountReminderPaused } = await import('@/lib/billing/reminder-snooze')
        const acct = acc as { dunning_pause?: boolean | null; dunning_pause_until?: string | null } | null
        if (isAccountReminderPaused(acct)) {
          const until = acct?.dunning_pause_until
          outcomes.push({ id, invoice_number: invNo, status: 'skipped', reason: `Reminders paused for this client${until ? ` until ${until}` : ''}` })
          continue
        }
      }

      // 2-reminder cap gate (override = explicit staff force-send).
      if (!opts.overrideCap && Number(p.reminder_count ?? 0) >= 2) {
        outcomes.push({ id, invoice_number: invNo, status: 'skipped', reason: 'Already at 2-reminder limit' })
        continue
      }

      const r = await sendReminderEmail(id, { source: 'manual' })
      if (r.ok && r.sent) outcomes.push({ id, invoice_number: invNo, status: 'sent', recipient: r.recipient })
      else if (r.alreadySent) outcomes.push({ id, invoice_number: invNo, status: 'skipped', reason: 'Already sent recently' })
      else outcomes.push({ id, invoice_number: invNo, status: 'failed', reason: r.error ?? 'Send failed' })
    }

    revalidatePath('/finance')
    const sent = outcomes.filter(o => o.status === 'sent').length
    const skipped = outcomes.filter(o => o.status === 'skipped').length
    const failed = outcomes.filter(o => o.status === 'failed').length
    return { outcomes, sent, skipped, failed }
  }, {
    action_type: 'update',
    table_name: 'payments',
    summary: `Bulk invoice reminders — ${paymentIds.length} selected`,
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

    // A total edit used to write ONLY payments.total/amount/subtotal/amount_due,
    // leaving payment_items (the actual invoice document/PDF line items) showing
    // the pre-edit figure forever — the root cause of the 2026-08-31 ShoppyVerse/
    // Growly investigation (12 real invoices found with a stale line item vs a
    // corrected total). Now the one adjustable service line is corrected in the
    // SAME operation — see adjustSingleServiceLineForTotal's doc comment for why
    // it refuses rather than guessing on an invoice with more than one line.
    if (updates.total !== undefined) {
      const { adjustSingleServiceLineForTotal } = await import('@/lib/portal/invoice-regenerate')
      const { syncClientExpenseItemsMirror } = await import('@/lib/portal/td-invoice-mirror')

      const { data: currentPay } = await supabaseAdmin
        .from('payments')
        .select('amount_paid')
        .eq('id', paymentId)
        .single()
      const amountPaid = Math.max(Number(currentPay?.amount_paid) || 0, 0)

      const { data: itemRows } = await supabaseAdmin
        .from('payment_items')
        .select('description, quantity, unit_price, amount, sort_order, item_type')
        .eq('payment_id', paymentId)
        .order('sort_order', { ascending: true })
      const currentItems = (itemRows ?? []).map((i) => ({
        description: (i as unknown as { description: string }).description,
        quantity: Number((i as unknown as { quantity: number | null }).quantity) || 1,
        unit_price: Number((i as unknown as { unit_price: number | null }).unit_price) || 0,
        amount: Number((i as unknown as { amount: number | null }).amount) || 0,
        // item_type is newer than the generated Supabase types (same gap as
        // credit-netting.ts's identical cast) — see the codebase-wide pattern there.
        item_type: (i as unknown as { item_type?: string | null }).item_type === 'fee' ? 'fee' : 'service',
      }))

      const adjustment = adjustSingleServiceLineForTotal(currentItems, updates.total)
      if (!adjustment.ok) {
        throw new Error(adjustment.reason || 'Could not adjust this invoice’s total safely.')
      }

      // eslint-disable-next-line no-restricted-syntax -- in-place line-item correction alongside the total edit below, same shape as credit-netting.ts's proven delete+reinsert
      await supabaseAdmin.from('payment_items').delete().eq('payment_id', paymentId)
      if (adjustment.items.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- see above
        await supabaseAdmin.from('payment_items').insert(
          adjustment.items.map((item, i) => ({
            payment_id: paymentId,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: item.amount,
            sort_order: i,
            item_type: item.item_type === 'fee' ? 'fee' : 'service',
          })),
        )
      }
      await syncClientExpenseItemsMirror(paymentId, adjustment.items.map((item, i) => ({ ...item, sort_order: i })))

      payUpdates.total = updates.total
      payUpdates.amount = updates.total
      payUpdates.subtotal = updates.total
      // Real cash already paid still counts — a correction on an already-Paid
      // invoice must not reopen its balance. (Pre-existing bug independent of
      // the line-item fix above: the prior code always set amount_due to the
      // FULL new total, so correcting the total on any already-paid invoice —
      // ShoppyVerse's/Growly's exact shape — would have wrongly reopened it.)
      payUpdates.amount_due = Math.max(Math.round((updates.total - amountPaid) * 100) / 100, 0)
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

    // Moving the due date into the future on an Overdue invoice un-marks it IMMEDIATELY —
    // back to Partial if money was applied, else Sent. Overdue-marking was one-way for its
    // whole life: the daily pass flips past-due invoices Overdue but nothing ever flipped
    // one back, so a renegotiated payment date (Shoppyverse → September, Luca 2026-07-28)
    // left the label stuck forever. The daily pass now heals this too (step 1b), but the
    // person editing the date deserves to SEE the status change, not wait a day for a cron.
    // Reminder count resets — a renegotiated date starts a fresh reminder cycle.
    if (updates.due_date) {
      const today = new Date().toISOString().split('T')[0]
      if (updates.due_date >= today) {
        const { data: inv } = await supabaseAdmin
          .from('payments')
          .select('invoice_status, amount_paid')
          .eq('id', paymentId)
          .single()
        if (inv?.invoice_status === 'Overdue') {
          const { syncInvoiceStatus } = await import('@/lib/portal/unified-invoice')
          const backTo = Number(inv.amount_paid ?? 0) > 0 ? 'Partial' : 'Sent'
          await syncInvoiceStatus('payment', paymentId, backTo)
          // eslint-disable-next-line no-restricted-syntax -- reminder pacing reset alongside the status flip
          await supabaseAdmin.from('payments').update({ reminder_count: 0 }).eq('id', paymentId)
        }
      }
    }

    // client_expenses mirror (dev job 0dcb0a18): a database trigger on `payments`
    // now applies this same due_date/total/subtotal/description change to the
    // client-facing copy automatically, the instant the `payments` update above
    // lands — nothing to do here anymore. (Deliberately still never touches
    // `notes`: those are internal staff remarks, and the trigger doesn't sync
    // that column either — decided 2026-07-03.)

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

/**
 * "This is mine" — Antonio claims a Bank Feed row for My Finances.
 *
 * The mirror of the "This is for a client" button in My Finances. The automatic rule keeps
 * anything that COULD be a client payment in Finance (a pinned candidate, an amount near an
 * open invoice); this is his one-click override when he looks at a row and knows it is his
 * own money. First real case: a Relay "Partner Payout Program" deposit held in the review
 * queue by a wrong auto-matched candidate.
 *
 * Admin gate is INSIDE the action — button visibility is not a security boundary. Staff must
 * not be able to move money out of the invoice queue into the owner's books.
 */
export async function claimBankFeedForOwner(feedId: string): Promise<ActionResult> {
  const { createClient } = await import('@/lib/supabase/server')
  const { isAdmin } = await import('@/lib/auth')
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return { success: false, error: 'Admin access required' }
  }

  return safeAction(async () => {
    const { sendFeedToOwnerLedger } = await import('@/lib/finance/owner-ledger-projection')
    const result = await sendFeedToOwnerLedger(feedId)
    if (!result.ok) throw new Error(result.error ?? 'Could not move it to My Finances.')
    revalidatePath('/finance')
    revalidatePath('/reconciliation')
    revalidatePath('/owner')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: 'Bank feed claimed for My Finances (owner money, not a client payment)',
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

/**
 * Restore a transaction that was wrongly flagged as a duplicate.
 *
 * The old dedup rule flagged any two unmatched rows sharing source + amount + day +
 * sender name — which is what a client legitimately paying two invoices of the same
 * price on the same day looks like. The rule is deleted, but the rows it produced
 * are still sitting there, invisible. This puts the money back in the queue.
 *
 * Only touches rows currently flagged `duplicate`: it must never resurrect a row a
 * human deliberately ignored, nor un-match reconciled money.
 */
export async function restoreBankFeed(feedId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    const { data: feed, error: readErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id, status')
      .eq('id', feedId)
      .maybeSingle()
    if (readErr) throw new Error(`Failed to read bank feed: ${readErr.message}`)
    if (!feed) throw new Error('Transaction not found.')
    if (feed.status !== 'duplicate') {
      throw new Error(`Only duplicate-flagged transactions can be restored — this one is "${feed.status}".`)
    }

    // eslint-disable-next-line no-restricted-syntax -- targeted status reset on td_bank_feeds
    const { error: restoreErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .update({ status: 'unmatched', updated_at: new Date().toISOString() })
      .eq('id', feedId)
      .eq('status', 'duplicate')
    if (restoreErr) throw new Error(`Failed to restore bank feed: ${restoreErr.message}`)

    revalidatePath('/finance')
    revalidatePath('/reconciliation')
  }, {
    action_type: 'update',
    table_name: 'td_bank_feeds',
    record_id: feedId,
    summary: 'Bank feed restored from duplicate — returned to the matching queue',
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

    if (delErr) {
      // 23503 = foreign-key violation. The ledger's feed_id is ON DELETE RESTRICT, so a
      // transaction that has applied money to an invoice CANNOT be deleted — deleting it
      // would erase the record of that application while the money stayed on the invoice,
      // freeing the same transaction to be credited again later. Say that in words a human
      // can act on, not as a raw Postgres error (R099).
      if (delErr.code === '23503') {
        throw new Error(
          'This transaction has applied money to an invoice, so it cannot be deleted. Unmatch it first if it really is a duplicate.',
        )
      }
      throw new Error(`Failed to delete duplicate: ${delErr.message}`)
    }

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

/**
 * Un-match an invoice from the bank transaction(s) that paid it, and put the invoice back to
 * the state it is HONESTLY in.
 *
 * ⛔ WHAT THIS USED TO DO, AND WHY EACH PART WAS WRONG (rewritten 2026-07-29 after the
 * LC Marketing → Aces mis-match).
 *
 *  1. **It left the money ledger untouched.** The `payment_applications` row saying "this
 *     transaction paid this invoice" survived, so the books recorded one $1,000 wire as having
 *     settled $2,000 across two companies — and any later attempt to match that transaction to
 *     that invoice would report SUCCESS while moving nothing, because the leftover row looks
 *     like proof the money is already there.
 *  2. **It wrote `amount_paid = 0`.** Un-matching ONE transaction erased every other genuine
 *     part-payment on the invoice — money that arrived by card or by another wire.
 *  3. **It forced `Draft`.** The invoice had been sent to the client and chased; calling it a
 *     draft removed a real receivable from the outstanding total and lied about the record.
 *  4. **It reset EVERY linked transaction to `unmatched`**, resurrecting rows an operator had
 *     deliberately ignored, and outgoing transfers that were never invoice payments — the bug
 *     the void path had already fixed with `partitionFeedsForUnlink`.
 *  5. **It found transactions by `matched_payment_id`.** A wire split across several invoices
 *     stamps only the FIRST one, so invoices 2..N of a waterfall were invisible: their money
 *     stayed credited with nothing behind it. The LEDGER is the only complete record.
 *  6. **It left the "invoice paid" note standing** in the staff feed, and that note's dedup key
 *     is permanent — so the invoice could never announce a genuine payment afterwards. That was
 *     Luca's original bug report.
 */
export async function unlinkPayment(
  paymentId: string,
): Promise<ActionResult<{ warning?: string }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listConfirmedApplications, reverseFeedApplication } = await import('@/lib/finance/apply-payment')
    const { updateFeed } = await import('@/lib/finance/feed-write')
    const { appendRejectedPair } = await import('@/lib/finance/feed-vocabulary')
    const { partitionFeedsForUnlink } = await import('@/lib/billing/invoice-reactivate')
    const now = new Date().toISOString()
    const today = now.slice(0, 10)

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number')
      .eq('id', paymentId)
      .maybeSingle()
    if (!payment) throw new Error('Invoice not found')

    const actor = 'dashboard:unlink'

    // 1. Reverse the money, one (transaction → invoice) pair at a time, each with its OWN
    //    recorded amount. Found via the ledger, never via the feed pointer.
    const applications = await listConfirmedApplications(paymentId)
    const reversedFeedIds: string[] = []
    const problems: string[] = []

    for (const app of applications) {
      const result = await reverseFeedApplication({
        feedId: app.feed_id,
        paymentId,
        actor,
        today,
      })
      if (result.reversed) {
        reversedFeedIds.push(app.feed_id)
        if (result.warning) problems.push(result.warning)
      } else if (result.reason !== 'no_application') {
        // A reversal that could not complete must STOP the operation. Carrying on would clear
        // the transaction's pointer while its money is still sitting on the invoice — the
        // orphaned state this whole rewrite exists to remove.
        throw new Error(result.detail ?? 'The payment could not be reversed.')
      }
    }

    // 2. Feed pointers. A CONFIRMED `matched` row returns to the queue; anything else
    //    (ignored / outgoing / duplicate) only loses its stale pointer and KEEPS its status.
    const { data: linkedFeeds, error: feedReadErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id, status')
      .eq('matched_payment_id', paymentId)
    if (feedReadErr) throw new Error(`Failed to read bank feeds: ${feedReadErr.message}`)

    const { resetIds, clearIds } = partitionFeedsForUnlink(linkedFeeds ?? [])

    for (const feedId of resetIds) {
      // Record the human's "no" on the transaction so the automatic matcher never re-proposes
      // this pair. Without it the 15-minute sync re-credits the invoice a person just cleared.
      const { data: existing } = await supabaseAdmin
        .from('td_bank_feeds')
        .select('review_metadata')
        .eq('id', feedId)
        .maybeSingle()

      const res = await updateFeed(feedId, {
        matched_payment_id: null,
        match_confidence: null,
        matched_at: null,
        matched_by: null,
        status: 'unmatched',
        review_metadata: appendRejectedPair(existing?.review_metadata, {
          payment_id: paymentId,
          at: now,
          by: actor,
        }),
      }, 'unlink-payment:reset')
      if (!res.ok) throw new Error(`Failed to unlink bank transaction: ${res.error}`)
    }

    for (const feedId of clearIds) {
      const res = await updateFeed(feedId, {
        matched_payment_id: null,
        match_confidence: null,
      }, 'unlink-payment:clear-suggestion')
      if (!res.ok) throw new Error(`Failed to clear the bank transaction's pointer: ${res.error}`)
    }

    // 3. Retire the "invoice paid" note. Soft-delete, not hard: the row is the audit trail, and
    //    the note emitter skips deleted rows when it dedups — so retiring this one also
    //    unblocks a correct note if the invoice is genuinely paid later.
    if (reversedFeedIds.length > 0) {
      const { retirePaymentReceivedNote } = await import('@/lib/portal/chat-events')
      // No uuid here: this runs as a server action for the signed-in staff user, and
      // `deleted_by` is a uuid column — the actor LABEL would be rejected by the database.
      await retirePaymentReceivedNote({ paymentId })
    }

    revalidatePath('/finance')
    revalidatePath('/accounts')

    // The work COMPLETED; `problems` holds a partial-success warning (the money came off but a
    // record could not be unlocked). Throwing here made safeAction report failure on a finished
    // operation, so the UI showed a red error for work that had actually been done — and the
    // real warning was indistinguishable from "nothing happened". Return it instead.
    return { warning: problems.length > 0 ? problems.join(' ') : undefined }
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice un-matched from its bank transaction — money reversed, state restored',
  })
}
