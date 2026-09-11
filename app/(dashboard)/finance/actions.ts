'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import type { DryRunResult } from '@/lib/operations/destructive'
import { wasFullyPaid as wasInvoiceFullyPaid } from '@/lib/finance/invoice-matchability'

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
  /**
   * Threaded through to createTDInvoice, which applies it before account
   * credit is computed (dev job 06fb1ad2). This wrapper's own input type
   * didn't declare the field at all — so even after createTDInvoice learned
   * to accept a real discount, both callers of this function (Finance's
   * two New Invoice tabs) had no way to pass one through, and staff-typed
   * discounts on the Finance page kept doing nothing.
   */
  discount?: number
}): Promise<ActionResult<{ id: string; invoice_number: string; duplicate_warning?: string }>> {
  return safeAction(async () => {
    const { createTDInvoice } = await import('@/lib/portal/td-invoice')
    const { fetchSettingsBanks, selectSettingsBank } = await import('@/lib/invoice-auto-send')

    const bankPref = input.bank_preference || 'auto'
    const legacyPrefs = new Set(['auto', 'relay', 'mercury', 'revolut', 'airwallex'])

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

    // The message field stores ONLY the staff-typed note going forward —
    // it used to also carry a machine-generated "Bank Transfer: ..."
    // paragraph baked in at creation time, which every downstream renderer
    // (PDF, email) then echoed verbatim with no way to hide it from
    // portal-audience clients who should never see bank details at all
    // (dev jobs 1834af40 / 96e56d06). Bank details are now resolved fresh,
    // and gated by audience, at send/render time instead — see
    // resolveBankDetails()/sanitizeInvoiceMessage() in lib/invoice-auto-send.ts
    // and lib/portal/pay-token.ts.
    const paymentMethod = input.payment_method || 'both'

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
      message: (input.message || '').trim() || undefined,
      payment_method: paymentMethod === 'card' ? 'Card' : paymentMethod === 'bank_transfer' ? `Wire Transfer (${bankLabel})` : `Wire Transfer (${bankLabel}) / Card`,
      bank_preference: bankPref,
      mark_as_paid: input.mark_as_paid || false,
      installment: input.installment || undefined,
      discount: input.discount,
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
      .select('id, invoice_number, amount_paid, invoice_status, account_id')
      .eq('id', paymentId)
      .single()
    if (!payment) throw new Error('Payment not found')

    // Fixed 2026-09-07 (full second-round council review): a credit note is
    // never "marked Paid" through this button — it's already settled by
    // definition, tracked through `credit_remaining`, not `amount_paid`.
    // A credit note's `amount_paid` is negative, which the partial-payment
    // guard below (a positivity check) never catches, and its coarse
    // `status` is already 'Paid' at creation for most creation paths — but
    // NOT all of them (the paid-call-credit path leaves `status='Pending'`
    // until the follow-up write), so this button could actually fire a real
    // write that flips a credit note's `invoice_status` to 'Paid', making it
    // permanently invisible to credit-netting. Gate on the row's real type,
    // not on a number's sign.
    if (payment.invoice_status === 'Credit') {
      throw new Error(
        'This is a credit note, not an invoice — it settles through its own remaining-credit balance, not "Mark as Paid". Edit it directly if the amount needs correcting.'
      )
    }

    // Fixed 2026-09-07 (full council review, blocker #1): a genuinely
    // Partial invoice (real money already recorded) reaches this same
    // button. Kept as an explicit refusal rather than letting the writer
    // below net it out (dev job 41e33dc5, 2026-09-09 review) — that would be
    // safe (a real compare-and-swap, correct remaining-balance math) but is
    // a silent behavior change from today's hard stop, and Antonio hasn't
    // picked between keeping the refusal, auto-completing, or a one-click
    // confirm. Revisit once he does.
    const alreadyPaid = Number(payment.amount_paid ?? 0)
    if (alreadyPaid > 0) {
      throw new Error(
        `This invoice already shows ${alreadyPaid} paid — marking it Paid here would overwrite that with the full amount instead of adding to it. Use Edit to reconcile the real balance, or apply the remaining payment through the normal payment-matching flow.`
      )
    }

    const today = new Date().toISOString().split('T')[0]

    // Routed through the one shared, CAS-protected money writer (dev job
    // 41e33dc5, full council review 2026-09-09) instead of a hand-rolled
    // update. The old inline update's only concurrency guard —
    // `.neq('status','Paid')` — shared the same stale read as `paidAmount`
    // above: a bank-feed partial payment landing in between (which only
    // ever moves `invoice_status`, never the coarse `status` column) was
    // invisible to it, so the stale full total could silently overwrite a
    // real partial. applyMoneyToInvoice re-reads the row itself and its own
    // write only lands if `amount_paid` still matches that fresh read —
    // same fallback math as before (`total ?? amount`), plus the guard this
    // button was missing.
    const { applyMoneyToInvoice } = await import('@/lib/finance/apply-payment')
    const apply = await applyMoneyToInvoice({
      paymentId,
      mode: 'settle_full',
      paidDate: today,
      paymentMethod,
      actor: 'finance:mark-paid',
    })
    // Mirrors confirmPayment's own identical check (lib/operations/payment.ts) —
    // applyMoneyToInvoice reports a refusal (terminal invoice, zero-total,
    // lost the compare-and-swap) by RETURNING applied:false, not by
    // throwing. Skipping this check would let every side effect below fire
    // on a no-op: a false "paid" receipt, a false "client paid" note, and —
    // since this button also triggers service activation below — a service
    // switched on for a payment that was never actually recorded.
    if (!apply.applied) {
      throw new Error(
        apply.detail || 'Nothing was applied — this invoice may already be closed, or it changed since it loaded. Refresh and check its current state before trying again.'
      )
    }

    // Fire-and-forget receipt email (E2E production QA sweep, Antonio's
    // explicit call: match the old page's behavior). Must not block the Paid
    // transition — same fire-and-forget shape as the old Payment Tracker
    // page's own version of this button.
    import('@/lib/invoice-auto-send').then(({ sendPaidReceipt }) =>
      sendPaidReceipt(paymentId).catch((err) =>
        console.error('[markInvoicePaid] receipt send failed:', err),
      ),
    )

    // Sync to client_expenses (portal mirror). applyMoneyToInvoice already
    // synced the STATUS half (syncTDInvoiceStatus — also the sole emitter of
    // the staff "Client paid" note); syncTDInvoiceMirror is the separate,
    // authoritative projection of the balances and isn't called internally.
    const { syncTDInvoiceMirror } = await import('@/lib/portal/td-invoice-mirror')
    await syncTDInvoiceMirror(paymentId)

    // QB sync (non-blocking)
    try {
      const { syncPaymentToQB } = await import('@/lib/qb-sync')
      syncPaymentToQB(paymentId, { paymentDate: today }).catch(() => {})
    } catch { /* QB sync not critical */ }

    // If this invoice is what a client's setup was waiting on, continue it —
    // the old Payment Tracker page's Mark Paid already did this; this button
    // (used by both Finance's own grid and the Account page's row actions)
    // did not, so a client whose payment got matched by hand instead of by
    // the automatic bank-feed matcher stayed frozen with nothing re-checking
    // it. Fixed 2026-09-07 (dev job ef5da377).
    const { triggerActivationIfPending } = await import('@/lib/operations/activate-service')
    await triggerActivationIfPending(paymentId)

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

    // Remove the client-portal mirror (and its own children) first — neither
    // FK cascades, so this must run before the payments delete below and
    // must not swallow a failure. Fixed 2026-09-06 (dev job ef5da377): this
    // used to delete client_expenses directly without clearing its own
    // client_expense_items first, so it failed every time on any invoiced
    // payment that had recorded line items — confirmed live on sandbox.
    // Shared with the old page's deleteInvoice so the two can't drift again.
    const { deleteClientExpenseMirror } = await import('@/lib/portal/td-invoice-mirror')
    await deleteClientExpenseMirror(paymentId)

    // Delete the invoice's own line items — this FK doesn't cascade either
    // (confirmed live: fixing the mirror-cleanup above unmasked this as the
    // NEXT failure, same session, same job). Missing entirely until now.
    const { error: itemsErr } = await supabaseAdmin.from('payment_items').delete().eq('payment_id', paymentId)
    if (itemsErr) throw new Error(`Deleting the invoice's line items failed: ${itemsErr.message}`)

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
  // Fixed 2026-09-07 (second-round council review, Bug-Hunter): voiding a
  // credit note flips its invoice_status away from 'Credit', making its
  // credit_remaining invisible to every credit-netting query (all of them
  // filter on invoice_status='Credit'). Recoverable via Reactivate, but
  // there's no reason to let it happen at all — a credit note isn't voided
  // the way an invoice is.
  if (before.invoice_status === 'Credit') {
    return { success: false, error: 'This is a credit note — it isn\'t voided like an invoice. Edit it directly if it needs correcting.' }
  }
  const preVoidState = capturePreVoidState(before)

  return safeAction(async () => {
    const now = new Date().toISOString()

    // Update payment. The pre-checks above (not-Cancelled, not-Credit) ran on
    // a read taken before this write — a race (a second tab, the bank-feed
    // auto-matcher) can settle the invoice in between. Re-asserted here,
    // atomically with the write itself, and widened to also exclude Paid
    // (this action's own eligibility hides Void once an invoice is Paid, but
    // nothing below the UI enforced it — a stale click could still cancel an
    // already-fully-paid invoice while amount_paid stayed on record). Row
    // count checked after, mirroring the sibling fix already shipped on the
    // old Payment Tracker page's own voidInvoice (dev job ef5da377).
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { data: voidedRows, error: voidErr } = await supabaseAdmin.from('payments').update({
      status: 'Cancelled', invoice_status: 'Cancelled', updated_at: now,
      // Free the idempotency slot (gate defect, 2026-08-11 — found by Antonio's real click):
      // this is the THIRD door that marks an invoice dead, and it was the only one still keeping
      // the key. The key is globally unique while present, so a cancelled tranche part blocked
      // its own re-raise with a collision — the corpse-bug's sibling, one file over from where
      // the council fixed it. The cascade and the payments-page void both already release it.
      idempotency_key: null,
    }).eq('id', paymentId)
      .not('invoice_status', 'in', '("Paid","Cancelled","Credit")')
      .select('id')
    if (voidErr) throw new Error(`Failed to void payment: ${voidErr.message}`)
    if (!voidedRows || voidedRows.length === 0) {
      throw new Error('This invoice changed before the void landed — it may now be Paid, already cancelled, or a credit note. Refresh and check its current state before trying again.')
    }

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
    const { parsePreVoidState, resolveReactivateTarget, reactivateBlocker, isCancelledInvoice } = await import('@/lib/billing/invoice-reactivate')
    const { projectedReminderCount, daysPastDue, isAutoSendEnabled } = await import('@/lib/billing/dunning')
    const { isAccountReminderPaused } = await import('@/lib/billing/reminder-snooze')

    const { data: payment } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, status, invoice_status, total, amount, amount_due, amount_paid, amount_currency, due_date, sent_at, reminder_count, account_id')
      .eq('id', paymentId)
      .maybeSingle()
    if (!payment) return { success: false, error: 'Invoice not found' }

    const label = payment.invoice_number ?? paymentId

    // Widened to also recognize the old Payment Tracker page's former
    // cancellation labels (status='Waived'/invoice_status='Voided') —
    // otherwise every invoice voided there before the 2026-09-07 label
    // unification stays permanently unreactivatable (dev job ef5da377).
    if (!isCancelledInvoice(payment)) {
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
  const { parsePreVoidState, resolveReactivateTarget, reactivateBlocker, isCancelledInvoice } = await import('@/lib/billing/invoice-reactivate')

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, status, invoice_status, total, amount, amount_paid, due_date, sent_at')
    .eq('id', paymentId)
    .maybeSingle()
  if (!payment) return { success: false, error: 'Invoice not found' }
  // Widened to also recognize the old Payment Tracker page's former
  // cancellation labels (status='Waived'/invoice_status='Voided') —
  // otherwise every invoice voided there before the 2026-09-07 label
  // unification stays permanently unreactivatable (dev job ef5da377).
  if (!isCancelledInvoice(payment)) {
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

    // TOCTOU guard: only reactivate if it is STILL cancelled. Widened to
    // 'Voided' alongside 'Cancelled' — nothing in this codebase writes
    // invoice_status='Voided' going forward (confirmed by search), so this
    // only ever matches the old page's former cancellation label, never a
    // fresh write (dev job ef5da377).
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { data: updated, error } = await supabaseAdmin
      .from('payments')
      .update(patch)
      .eq('id', paymentId)
      .in('invoice_status', ['Cancelled', 'Voided'])
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
  updates: { description?: string; due_date?: string; notes?: string; message?: string; total?: number },
  correctionPath?: 'partial_payment' | 'typo'
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
    // Set only when a total edit reads `current` below — the token the final
    // write's compare-and-swap guards against, so a stale read can't land.
    let expectedUpdatedAt: string | null = null
    if (updates.total !== undefined) {
      // Fixed 2026-09-06 (dev job ef5da377, Step 4): this used to set amount_due
      // to the new total outright, ignoring whatever was already paid — so
      // editing the amount on a Partial invoice erased the record of the
      // partial payment, and editing it on an already-Paid invoice (this
      // button has no status gate) reopened a paid invoice as owing money
      // again. amount_due is now derived from what's actually still owed.
      const { data: current } = await supabaseAdmin
        .from('payments')
        .select('amount_paid, status, invoice_status, total, credit_remaining, stripe_payment_id, whop_payment_id, updated_at, invoice_number, account_id')
        .eq('id', paymentId)
        .single()
      if (!current) throw new Error('Invoice not found')
      expectedUpdatedAt = current.updated_at ?? null

      const isCreditNote = current.invoice_status === 'Credit'

      // Fixed 2026-09-07 (E2E production QA sweep, dev job ef5da377, round 2 —
      // council-reviewed): the Edit action has no status gate at all, and a
      // voided/cancelled invoice fell into the "ordinary edit" branch below
      // (wasFullyPaid reads false for it, since 'Cancelled'/'Voided' isn't
      // 'Paid') — which could then silently PROMOTE it back to Paid at the
      // new total, while amount_paid stayed stuck at whatever it was before
      // voiding. Checked against BOTH cancellation vocabularies in this
      // codebase: the new page's void writes status/invoice_status='Cancelled';
      // the old, still-live Payment Tracker page's void writes
      // invoice_status='Voided', status='Waived'. A credit note is never in
      // either state (its invoice_status is always 'Credit'), so this can't
      // intersect with that already-correct handling.
      if (!isCreditNote && (
        current.status === 'Cancelled' || current.invoice_status === 'Cancelled' ||
        current.status === 'Waived' || current.invoice_status === 'Voided'
      )) {
        throw new Error('This invoice was voided/cancelled — reactivate it first before changing its total.')
      }

      // Fixed 2026-09-07 (full second-round council review, Bug-Hunter +
      // Finance-Auditor, independently): nothing anywhere validated the
      // sign of a corrected total. For an ordinary invoice, a fat-fingered
      // negative number could sail through the "ordinary edit" branch below
      // and get auto-promoted to Paid with $0 actually recorded — reaching
      // the client's own portal. Credit notes are the one deliberate
      // exception (their total is always negative by convention); every
      // other row must stay non-negative.
      if (!isCreditNote && updates.total < 0) {
        throw new Error('An invoice total can\'t be negative — negative amounts are only valid for credit notes.')
      }

      const amountPaid = Number(current.amount_paid ?? 0)
      // invoice_status only, not the coarse status enum too — a credit note's
      // `status` is ALSO always 'Paid' (createCreditNote always settles it),
      // but its `invoice_status` is 'Credit', not 'Paid'. Checking the coarse
      // enum here made editing a credit note's amount throw unconditionally
      // (the client-side gate only checks invoice_status, so it never showed
      // the correction prompt that would have supplied a path) — a real
      // regression found live 2026-09-07, second bug-hunter pass. Every real
      // invoice this gate is meant for sets both fields together (see
      // markInvoicePaid), so this loses no legitimate case.
      //
      // Fixed 2026-09-07 (E2E production QA sweep): this missed the ~47 real
      // legacy/pre-invoice payments in production whose invoice_status is
      // NULL (never backfilled) while their coarse status is 'Paid' —
      // editing one of those skipped this entire correction-path safety net
      // (the bank-confirmed cross-check, the card/Whop refusal) and fell
      // into the weaker "ordinary edit" branch below. Reads invoice_status
      // first, falling back to status ONLY when invoice_status is absent —
      // a credit note's invoice_status is 'Credit' (not null, not 'Paid'),
      // so this can't reopen the exact isCreditNote regression the comment
      // above already fixed once. Shared with the Account page's dialog and
      // Finance's own list view (dev job ef5da377) — see the function's own
      // doc comment for why this must never be swapped for isPaidInvoice.
      const wasFullyPaid = wasInvoiceFullyPaid(current)

      // Fixed 2026-09-07 (dev job ef5da377, Antonio-approved 3-way prompt):
      // editing the total on an already-Paid invoice is ambiguous — a typo
      // fix, a real partial-payment correction, and a brand-new charge all
      // LOOK like "the total changed" but need different treatment. The
      // caller (the correction prompt on both Finance's and the Account
      // page's Edit dialogs) must say which one this is; every non-Paid
      // invoice (Draft/Sent/Partial/Overdue) is unaffected and keeps the
      // plain behavior below.
      if (wasFullyPaid && !correctionPath) {
        throw new Error(
          'This invoice is already marked Paid. Choose whether this is a partial-payment correction or a typo fix before saving.'
        )
      }

      payUpdates.total = updates.total
      payUpdates.amount = updates.total
      payUpdates.subtotal = updates.total

      if (wasFullyPaid && correctionPath === 'partial_payment') {
        // The client didn't actually pay the new (higher) total in full.
        // Reopen the invoice to reflect what's really still owed — same
        // enum split the codebase already uses elsewhere (payments.status
        // has no "Partial" member; that lives only in invoice_status).
        const newAmountDue = Math.max(Math.round((updates.total - amountPaid) * 100) / 100, 0)
        // Fixed 2026-09-07 (full council review): a corrected total that's
        // still fully covered by what's already paid isn't a partial
        // payment — there's nothing left owing to "reopen". Silently
        // leaving amount_paid untouched here produced amount_paid > total
        // with no record of why. "Just a typo" is the right option for a
        // decrease.
        if (newAmountDue === 0) {
          throw new Error(
            `The corrected amount (${updates.total}) doesn't exceed what's already been paid (${amountPaid}) — there's nothing to reopen as partial. Use "Just fixing a typo" instead if the number itself was wrong.`
          )
        }
        payUpdates.amount_due = newAmountDue
        payUpdates.status = 'Pending'
        payUpdates.invoice_status = 'Partial'
        payUpdates.paid_date = null

        // Fixed 2026-09-07 (E2E production QA sweep, Antonio's explicit call:
        // flag it, don't auto-revoke). This invoice was Paid — meaning the
        // client's account/services were very likely already activated off
        // it — and is now being reopened as owing money again. Nothing here
        // pulls back portal access, a service delivery, or anything else
        // already granted; that's a deliberate choice, not an oversight.
        // A staff-visible flag (reuses the existing sticky-note/Staff-Alerts
        // feed, so nothing new to build or check) is the only signal that
        // this happened — without it, a fully-provisioned client silently
        // owes money again with no one aware.
        try {
          const { notesTable } = await import('@/lib/notes/staff-notes')
          const { error: flagErr } = await notesTable().insert({
            body: `Invoice ${current.invoice_number ?? paymentId} was corrected from Paid back to Partial (now owing ${newAmountDue}). The client's account/services may already be active from the earlier Paid status — nothing was automatically pulled back. Review whether this needs follow-up.`,
            visibility: 'team',
            account_id: current.account_id ?? null,
            author_name: 'System',
          })
          if (flagErr) console.error('[updateInvoice] staff flag note failed:', flagErr.message)
        } catch (err) {
          console.error('[updateInvoice] staff flag note failed:', err)
        }
      } else if (wasFullyPaid && correctionPath === 'typo') {
        // The whole figure was mistyped, not just the total — "the payment
        // itself doesn't change" means the invoice stays fully settled at
        // the CORRECTED number, not that the old (also-wrong) amount_paid
        // survives untouched. Found live 2026-09-07: leaving amount_paid at
        // its old value here reproduced the exact Paid-with-a-balance-due
        // bug this whole feature exists to prevent, just from the opposite
        // direction (the fix, not the original bug).
        //
        // Fixed 2026-09-07 (full council review): this trusted the
        // staff-entered number blindly, with no check against what a real
        // bank transaction actually confirmed — so it could silently
        // manufacture or erase real, verified cash. When this invoice has
        // confirmed bank money on file, the correction must match it.
        const { listConfirmedApplications } = await import('@/lib/finance/apply-payment')
        const confirmed = await listConfirmedApplications(paymentId)
        const confirmedSum = Math.round(confirmed.reduce((s, a) => s + Number(a.amount ?? 0), 0) * 100) / 100
        if (confirmedSum > 0 && Math.abs(updates.total - confirmedSum) > 0.01) {
          throw new Error(
            `This invoice has ${confirmedSum} in confirmed bank payments on file, which doesn't match the corrected total (${updates.total}). "Just a typo" isn't safe here — it would misrecord a real, verified payment. This needs a manual review instead.`
          )
        }
        // Fixed 2026-09-07 (full second-round council review, System
        // Counselor + Finance-Auditor, independently — the confirmed bank
        // check above only ever has data for wire-transfer settlements;
        // live production data showed that's a small minority of Paid
        // invoices). A card (Stripe) or Whop payment is just as real and
        // just as unsafe to silently overwrite, but there's no cheap way to
        // re-verify the exact amount actually charged without calling out
        // to Stripe/Whop directly — so when either is on file, "typo" is
        // refused outright instead of trusting the number blindly, the same
        // stance already taken for bank-confirmed money.
        //
        // Fixed 2026-09-07 (E2E production QA sweep, Bug-Hunter): this used
        // to skip entirely whenever ANY bank-confirmed amount existed
        // (`!confirmedSum`), sharing one variable with the check above as an
        // effective if/elif. On a real mixed-payment invoice — part bank
        // wire, part card — a bank-confirmed amount that happened to match
        // the corrected total passed the check above, then this one never
        // ran at all, silently erasing the real, separate card/Whop money
        // from the ledger. The two checks must be independent: this one now
        // fires whenever confirmed bank money does NOT already cover the
        // invoice's CURRENT (pre-correction) total — i.e. there's a real gap
        // a card/Whop charge could be filling — rather than whenever the
        // correction just happens to zero out the mismatch check above.
        //
        // Narrow, real exception (Bug-Hunter, same pass): the paid-call-credit
        // feature (lib/operations/paid-call-credit.ts) stamps a
        // stripe_payment_id onto an invoice purely as a bank-feed MATCHING
        // KEY when a call is attached by hand from a real bank transaction —
        // not because a card was actually charged. That case is already
        // covered by "confirmed bank money covers the current total", so no
        // separate flag is needed for it.
        const bankCoversCurrentTotal = confirmedSum > 0 && confirmedSum >= Number(current.total ?? 0) - 0.01
        if (!bankCoversCurrentTotal && (current.stripe_payment_id || current.whop_payment_id)) {
          throw new Error(
            'This invoice was settled by a card or Whop payment, which can\'t be safely re-verified here. "Just a typo" isn\'t safe on it — check the actual charge amount before correcting, or use "The client only paid part of it" / "There\'s a new charge on top" instead.'
          )
        }
        payUpdates.amount_paid = updates.total
        payUpdates.amount_due = 0
      } else if (isCreditNote) {
        // A credit note's real remaining balance lives in `credit_remaining`
        // — a SEPARATE field from `total`, consumed over time as it's
        // applied to later invoices (lib/operations/credit-netting.ts).
        // Correcting the note's total must preserve however much has
        // ALREADY been consumed, not leave the old figure stale — found
        // live 2026-09-07 (full council review): editing a credit note
        // never touched credit_remaining at all, so a corrected note could
        // still hand out the old, wrong amount on a future invoice.
        const oldTotalAbs = Math.abs(Number(current.total ?? 0))
        // Rounded to the cent (E2E QA sweep round 2, Bug-Hunter): computing
        // this from a subtraction, unrounded, could land a hair off a clean
        // 2-decimal figure from ordinary JS float error (e.g. 699.9900000000001
        // instead of 699.99) — wrongly refusing a correction that's actually
        // exact, on a row whose consumed amount happens to require this
        // subtraction. Every sibling money comparison in this function
        // already rounds for the same reason (see the typo-path and
        // ordinary-edit branches above).
        const consumed = Math.round(Math.max(oldTotalAbs - Number(current.credit_remaining ?? 0), 0) * 100) / 100
        const newTotalAbs = Math.abs(updates.total)
        // Fixed 2026-09-07 (full second-round council review, Senior
        // Engineer): if more has already been consumed than the corrected
        // total covers, silently flooring credit_remaining at 0 absorbed
        // the shortfall with no error and no trace — staff would have no
        // way to know the correction left a real discrepancy unexplained.
        if (consumed > newTotalAbs + 0.001) {
          throw new Error(
            `${consumed} of this credit note has already been applied to other invoices, which is more than the corrected amount (${newTotalAbs}) covers. Correcting it this low would silently write off the difference — this needs a manual review instead.`
          )
        }
        // Fixed 2026-09-07 (same pass, AI Architect + Finance-Auditor,
        // independently): a credit note's total/amount are always negative
        // by convention (createCreditNote's own rule) — nothing re-asserted
        // that on a correction, so retyping the pre-filled negative number
        // as a plain positive one (an easy, unlabeled mistake) silently
        // flipped a credit note's sign, including on a client-facing PDF.
        // The sign is derived here, never trusted from the input.
        payUpdates.total = -newTotalAbs
        payUpdates.amount = -newTotalAbs
        payUpdates.subtotal = -newTotalAbs
        payUpdates.amount_paid = -newTotalAbs
        payUpdates.credit_remaining = Math.max(newTotalAbs - consumed, 0)
        payUpdates.amount_due = 0

        // Fixed 2026-09-07 (E2E production QA sweep, Senior Engineer +
        // Bug-Hunter, independently): a corrected credit note's line items
        // never got touched, so its client-downloadable PDF (which renders
        // items and the header total as two independently-sourced fields)
        // permanently disagreed with itself after any correction. This is
        // deliberately NOT routed through adjustSingleServiceLineForTotal
        // (the generic line-adjuster below, skipped for credit notes) —
        // that function treats ANY negative-amount line as a "credit, never
        // adjust" line, and a credit note's own line IS that negative
        // amount, so it would refuse every single time. Written directly
        // from the already-computed, already-signed total instead.
        const { data: creditItemRows, error: creditItemsReadErr } = await supabaseAdmin
          .from('payment_items')
          .select('id, description, quantity')
          .eq('payment_id', paymentId)
          .order('sort_order', { ascending: true })
        if (creditItemsReadErr) {
          throw new Error(`Could not read this credit note's current line items — total was NOT changed. ${creditItemsReadErr.message}`)
        }
        const creditRows = creditItemRows ?? []
        if (creditRows.length === 1) {
          const only = creditRows[0] as { id: string; description: string | null; quantity: number | null }
          const qty = Number(only.quantity) || 1
          // eslint-disable-next-line no-restricted-syntax -- in-place credit-note line-item correction alongside the total edit, same pattern as the ordinary-invoice line-item rewrite below
          const { error: creditItemWriteErr } = await supabaseAdmin
            .from('payment_items')
            .update({ unit_price: -newTotalAbs / qty, amount: -newTotalAbs })
            .eq('id', only.id)
          if (creditItemWriteErr) {
            throw new Error(`Could not update this credit note's line item — total was NOT changed. ${creditItemWriteErr.message}`)
          }
          const { syncClientExpenseItemsMirror } = await import('@/lib/portal/td-invoice-mirror')
          await syncClientExpenseItemsMirror(paymentId, [{
            description: only.description ?? '',
            quantity: qty,
            unit_price: -newTotalAbs / qty,
            amount: -newTotalAbs,
            sort_order: 0,
          }])
        } else if (creditRows.length > 1) {
          // Ambiguous which of several lines a discretionary correction should
          // change — refuse rather than guess, matching the generic
          // adjuster's own refuse-on-ambiguity stance for ordinary invoices.
          throw new Error('This credit note has more than one line item — the total was corrected, but its line items need to be edited directly (they were not changed automatically).')
        }
        // Zero line items: nothing to sync, the header total is the whole story.
      } else {
        // An ordinary edit: recompute the balance from what's really been
        // paid so far.
        const newAmountDue = Math.max(Math.round((updates.total - amountPaid) * 100) / 100, 0)
        payUpdates.amount_due = newAmountDue
        // Fixed 2026-09-07 (full council review): status was never touched
        // here regardless of the resulting balance, which left two honest
        // gaps this closes: (a) an edit that brings the balance to exactly
        // 0 stayed in its old non-Paid status forever, so the automatic
        // overdue-reminder pass (lib/billing/dunning.ts) could still chase
        // a client who owes nothing; (b) a row whose coarse `status` is
        // already 'Paid' (a bare/legacy pre-invoice payment can carry this
        // even when invoice_status disagrees or is null) but whose edit
        // creates a balance stayed labeled Paid with money owing — the same
        // Paid-with-a-balance-due bug this whole feature exists to
        // prevent, just reachable from this side. Mirrors the promote/
        // reopen pattern already used by applyAvailableCreditToInvoice and
        // reconcileAccountCredits (lib/operations/credit-netting.ts).
        if (newAmountDue === 0 && current.status !== 'Paid') {
          payUpdates.status = 'Paid'
          // Fixed 2026-09-07 (E2E production QA sweep, Senior Engineer +
          // Bug-Hunter, independently): this used to tag invoice_status='Paid'
          // whenever it was already non-null, regardless of whether the row
          // had a real invoice_number — minting a "Paid, no invoice number"
          // row, a state the system treats elsewhere as meaning "this isn't a
          // real invoice" (app/api/invoices/[id]/pdf/route.ts falls back to a
          // "DRAFT" label with no invoice_number; the Finance grid's own
          // invoice list filters on invoice_status IS NOT NULL to mean "this
          // is an invoice"). The first fix checked only `!= null`, which
          // missed this codebase's own established fake-invoice-number
          // placeholders '1.0'/'2.0' — real production data, already
          // special-cased the same way in payment-row-actions.tsx,
          // account-detail.tsx, contact-detail.tsx, and td-invoice.ts. Only
          // tag it Paid when there's an actual invoice behind it.
          const hasRealInvoiceNumber = !!current.invoice_number && current.invoice_number !== '1.0' && current.invoice_number !== '2.0'
          if (hasRealInvoiceNumber) payUpdates.invoice_status = 'Paid'
          payUpdates.paid_date = now.split('T')[0]
        } else if (newAmountDue > 0 && current.status === 'Paid') {
          payUpdates.status = 'Pending'
          if (current.invoice_status === 'Paid') {
            payUpdates.invoice_status = amountPaid > 0 ? 'Partial' : 'Sent'
          }
          payUpdates.paid_date = null
        }
      }

      // Merged in from main 2026-09-07 (originally the 2026-08-31 ShoppyVerse/
      // Growly fix): a total edit used to write ONLY payments.total/amount/
      // subtotal/amount_due, leaving payment_items (the actual invoice
      // document/PDF line items) showing the pre-edit figure forever. The one
      // adjustable service line is now corrected in the SAME operation — see
      // adjustSingleServiceLineForTotal's doc comment for why it refuses
      // rather than guessing on an invoice with more than one line.
      //
      // Deliberately skipped for a credit note: adjustSingleServiceLineForTotal
      // treats ANY negative-amount line as a "credit" line to be preserved,
      // never as the adjustable one — a credit note's own line IS that negative
      // amount, so running this against one would refuse every single time
      // ("no service line found to adjust"), reopening the exact
      // credit-notes-can't-be-edited regression this session already found and
      // fixed once. Credit notes don't carry a comparable line-item document
      // today, so there is nothing here for them to stay in sync with.
      //
      // Runs AFTER every branch above (never before) so a rejected edit — a
      // failed validation, a disallowed correction path — never rewrites the
      // line items for a total that's about to be refused anyway. Uses the
      // FINAL total (payUpdates.total, set by every branch above) rather than
      // the raw input, so the line items always match what's actually being
      // saved.
      if (!isCreditNote) {
        const { adjustSingleServiceLineForTotal } = await import('@/lib/portal/invoice-regenerate')
        const { syncClientExpenseItemsMirror } = await import('@/lib/portal/td-invoice-mirror')

        const { data: itemRows, error: itemRowsErr } = await supabaseAdmin
          .from('payment_items')
          .select('description, quantity, unit_price, amount, sort_order, item_type')
          .eq('payment_id', paymentId)
          .order('sort_order', { ascending: true })
        if (itemRowsErr) {
          throw new Error(`Could not read this invoice's current line items — total was NOT changed. ${itemRowsErr.message}`)
        }
        const currentItems = (itemRows ?? []).map((i) => ({
          description: (i as unknown as { description: string }).description,
          quantity: Number((i as unknown as { quantity: number | null }).quantity) || 1,
          unit_price: Number((i as unknown as { unit_price: number | null }).unit_price) || 0,
          amount: Number((i as unknown as { amount: number | null }).amount) || 0,
          // item_type is newer than the generated Supabase types (same gap as
          // credit-netting.ts's identical cast) — see the codebase-wide pattern there.
          item_type: (i as unknown as { item_type?: string | null }).item_type === 'fee' ? 'fee' : 'service',
        }))

        const finalTotal = payUpdates.total as number
        const adjustment = adjustSingleServiceLineForTotal(currentItems, finalTotal)
        if (!adjustment.ok) {
          throw new Error(adjustment.reason || 'Could not adjust this invoice’s total safely.')
        }

        // Guarded delete + insert (finance-auditor council finding): an unchecked failure here
        // used to proceed straight to writing the new header total anyway, silently leaving a
        // real invoice with a correct total and ZERO line items. Both steps now throw on error,
        // before the payments.total write below ever runs — not a full DB transaction (still a
        // real gap: if the LATER payments.update fails, these two writes are not rolled back;
        // the new compare-and-swap guard below makes that late failure MORE likely than before
        // for a genuinely concurrent edit, not less — accepted, same as the pre-existing gap,
        // rather than wrapping this in a real transaction, which is a larger change than
        // reconciling these two fixes calls for), but this closes the specific "insert fails,
        // total still gets written" failure mode.
        // eslint-disable-next-line no-restricted-syntax -- in-place line-item correction alongside the total edit below, same shape as credit-netting.ts's proven delete+reinsert
        const { error: deleteItemsErr } = await supabaseAdmin.from('payment_items').delete().eq('payment_id', paymentId)
        if (deleteItemsErr) {
          throw new Error(`Could not clear this invoice's line items — total was NOT changed. ${deleteItemsErr.message}`)
        }
        if (adjustment.items.length > 0) {
          // eslint-disable-next-line no-restricted-syntax -- see above
          const { error: insertItemsErr } = await supabaseAdmin.from('payment_items').insert(
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
          if (insertItemsErr) {
            throw new Error(`This invoice's line items were cleared but could not be rewritten — it may now show no line items. Re-open it and try again, or contact dev. ${insertItemsErr.message}`)
          }
        }
        await syncClientExpenseItemsMirror(paymentId, adjustment.items.map((item, i) => ({ ...item, sort_order: i })))
      }
    }

    // Fixed 2026-09-07 (full second-round council review, Finance-Auditor):
    // every sibling money-writer in this file guards its write against a
    // stale read (markInvoicePaid's `.neq('status','Paid')`,
    // reactivateInvoice's `.eq('invoice_status','Cancelled')`,
    // apply-payment.ts's explicit compare-and-swap) — this one didn't. A
    // total edit computed off a snapshot that a concurrent payment then
    // settled could overwrite only the fields it touched, leaving the
    // concurrently-written amount_paid/status/invoice_status in place next
    // to a now-wrong amount_due — a real, demonstrated "Paid with a balance
    // due" state reached through a race instead of the branching logic.
    // Only guarded when a total edit actually read `current`; the plain
    // description/date/notes-only path has no money fields to race.
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    let updateQuery = supabaseAdmin.from('payments').update(payUpdates).eq('id', paymentId)
    if (expectedUpdatedAt !== null) updateQuery = updateQuery.eq('updated_at', expectedUpdatedAt)
    const { data: updatedRows, error: updatePayErr } = await updateQuery.select('id')
    if (updatePayErr) throw new Error(`Failed to update invoice: ${updatePayErr.message}`)
    if (expectedUpdatedAt !== null && (!updatedRows || updatedRows.length === 0)) {
      throw new Error('This invoice changed while you were editing it — refresh and check its current state before saving again.')
    }

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
          // Locked to the 'Overdue' just read above (dev job 6aebd8c0, full
          // council review 2026-09-09) — if a payment landed on this exact
          // invoice in the moment between that read and this write, the
          // flip is skipped rather than reverting a status a different
          // process just correctly set.
          const { synced } = await syncInvoiceStatus('payment', paymentId, backTo, undefined, undefined, 'Overdue')
          if (synced) {
            // eslint-disable-next-line no-restricted-syntax -- reminder pacing reset alongside the status flip
            await supabaseAdmin.from('payments').update({ reminder_count: 0 }).eq('id', paymentId)
          }
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
