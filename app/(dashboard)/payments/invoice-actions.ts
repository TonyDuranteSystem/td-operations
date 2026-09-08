'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { triggerActivationIfPending } from '@/lib/operations/activate-service'
import { deleteClientExpenseMirror } from '@/lib/portal/td-invoice-mirror'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import { type CreateInvoiceInput } from '@/lib/schemas/invoice'
import { PLAN_TOTAL_TOLERANCE, validatePaymentPlan } from '@/lib/offers/payment-plan'

// This file now holds ONLY the old Payment Tracker page's own, exclusive
// invoice actions (reachable solely via components/payments/invoice-detail-
// dialog.tsx, which the old page alone mounts). The functions shared with
// Finance/Accounts/Contacts/Notifications/Portal-Chats — createInvoice,
// createCreditNote, createOneTimeCustomer, regenerateInvoice — moved to
// app/(dashboard)/shared/invoice-actions.ts on 2026-09-06 (dev job ef5da377,
// Step 1). Everything left here is slated for deletion alongside the old
// page itself in a later step of that same job.

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

    // Verify still Draft. Also reads the tranche columns (postdate generated types, same cast
    // pattern the part1Query below already uses) — the plan guard right after needs them.
    const currentQuery = supabase
      .from('payments')
      .select('invoice_status, tranche_offer_token, tranche_seq' as never) as unknown as {
        eq: (c: string, v: unknown) => {
          single: () => Promise<{ data: { invoice_status: string; tranche_offer_token: string | null; tranche_seq: number | null } | null }>
        }
      }
    const { data: current } = await currentQuery.eq('id', paymentId).single()

    if (current?.invoice_status !== 'Draft') {
      throw new Error('Can only edit Draft invoices')
    }

    // ⛔ SAME PLAN GUARD AS createInvoice, APPLIED HERE TOO (2026-08-14, bug-hunter, 5th pass on
    // the release feature) — createInvoice's guard only runs at the moment a tranche invoice is
    // FIRST raised. This dialog can reopen and re-save that SAME Draft invoice afterward, through
    // the same discount field or a changed line item, with no awareness it belongs to a plan —
    // silently re-diverging it from the agreed part amount through a second door, undermining the
    // exact protection the create-time guard exists for. Same tolerance, same refusal wording.
    if (current.tranche_offer_token) {
      if ((input.discount || 0) > 0) {
        throw new Error(
          "A part of a payment plan cannot carry a separate discount — the plan's part amount is " +
          "already the figure owed. To reduce it, edit the plan on the offer, then save again.",
        )
      }
      const planQuery = supabaseAdmin
        .from('offers')
        .select('payment_plan' as never)
        .eq('token', current.tranche_offer_token) as unknown as {
          maybeSingle: () => Promise<{ data: { payment_plan?: unknown } | null }>
        }
      const { data: offerRow } = await planQuery.maybeSingle()
      const parsed = validatePaymentPlan(offerRow?.payment_plan)
      const part = parsed.ok && parsed.plan ? parsed.plan.find((p) => p.seq === current.tranche_seq) : undefined
      // ⛔ CURRENCY, NOT JUST AMOUNT — same gap, same fix as createInvoice (2026-08-14, bug-hunter,
      // 6th pass). Checked first: comparing amounts across different currencies is meaningless.
      if (part && part.currency !== input.amount_currency) {
        throw new Error(
          `Part ${part.seq} of this plan is agreed in ${part.currency} — this invoice is in ` +
          `${input.amount_currency}. They must match. Fix the currency, or fix the plan on the offer, then save again.`,
        )
      }
      if (part && Math.abs(total - part.amount) > PLAN_TOTAL_TOLERANCE) {
        throw new Error(
          `Part ${part.seq} of this plan is agreed at ${part.amount} — this invoice totals ${total}. ` +
          `They must match. Fix the amount, or fix the plan on the offer, then save again.`,
        )
      }
      // No matching part or an unparsable plan: same deliberate degrade as createInvoice — not
      // this guard's job to invent an opinion the money rails downstream already handle.
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
    // Finance reads the same payments table on its own Invoices tab —
    // revalidate both while the old Payment Tracker page still exists
    // (dev job ef5da377).
    revalidatePath('/finance')
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

    // Real invoices always have `total` set (via createTDInvoice) — unlike a
    // bare payment placeholder, which never does. Reading it here is what
    // was missing: this write used to flip status without ever recording
    // the amount, leaving amount_paid/amount_due stale on a Paid invoice.
    const { data: payment, error: fetchErr } = await supabase
      .from('payments')
      .select('total')
      .eq('id', paymentId)
      .single()
    if (fetchErr) throw new Error(fetchErr.message)

    const today = new Date().toISOString().split('T')[0]
    const updates: Record<string, unknown> = {
      status: 'Paid',
      invoice_status: 'Paid',
      paid_date: today,
      amount_paid: payment.total,
      amount_due: 0,
      updated_at: new Date().toISOString(),
    }
    if (paymentMethod) updates.payment_method = paymentMethod

    // Fixed 2026-09-07 (E2E production QA sweep, Bug-Hunter): this had no
    // row-count check at all — a stale page (the bank-feed matcher settles
    // the invoice Partial in the background before the click lands) still
    // fired a "Paid in full" receipt email and activated the client's
    // account even though nothing was actually written. Mirrors the same
    // fix already shipped on Finance's own markInvoicePaid.
    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
    const { data: markPaidRows, error } = await supabase
      .from('payments')
      .update(updates)
      .eq('id', paymentId)
      .in('invoice_status', ['Sent', 'Overdue'])
      .select('id')

    if (error) throw new Error(error.message)
    if (!markPaidRows || markPaidRows.length === 0) {
      throw new Error('This invoice changed before the save landed — it may no longer be Sent or Overdue. Refresh and check its current state before trying again.')
    }

    // Fire-and-forget receipt email — must not block the Paid transition.
    import('@/lib/invoice-auto-send').then(({ sendPaidReceipt }) =>
      sendPaidReceipt(paymentId).catch((err) =>
        console.error('[markInvoicePaid] receipt send failed:', err),
      ),
    )

    // Sync to client_expenses (portal mirror) — Finance's own markInvoicePaid
    // already does this; this button didn't, so a client marked Paid here
    // could still see their old balance in the portal (dev job ef5da377).
    const { syncTDInvoiceStatus } = await import('@/lib/portal/td-invoice')
    await syncTDInvoiceStatus(paymentId, 'Paid', today, Number(payment.total))
    const { syncTDInvoiceMirror } = await import('@/lib/portal/td-invoice-mirror')
    await syncTDInvoiceMirror(paymentId)

    // QB sync removed — QB is now one-way manual via the CRM finance "Push to QuickBooks" button.

    // If this invoice is what a client's setup was waiting on, continue it —
    // shared with Finance's markInvoicePaid so both entry points behave the
    // same way (dev job ef5da377).
    await triggerActivationIfPending(paymentId)

    revalidatePath('/payments')
    revalidatePath('/accounts')
    // Finance reads the same payments table on its own Invoices tab —
    // revalidate both while the old Payment Tracker page still exists
    // (dev job ef5da377).
    revalidatePath('/finance')
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
  const { capturePreVoidState, partitionFeedsForUnlink } = await import('@/lib/billing/invoice-reactivate')

  // Fixed 2026-09-07 (E2E production QA sweep, Antonio's explicit call: a
  // temporary duplicate bridge, given the old page is not being retired
  // today). Two real gaps closed, mirroring Finance's own voidInvoice: (1)
  // this write now uses the SAME status vocabulary as the new page
  // (status/invoice_status='Cancelled', not 'Waived'/'Voided') — the old
  // labels made a voided-here invoice permanently un-reactivatable, since
  // Reactivate only recognizes literal 'Cancelled' (confirmed by
  // Bug-Hunter: two different reviewers independently found this exact
  // dead end). (2) a matched bank feed used to be left dangling — the money
  // stayed recorded against a cancelled invoice with no way back into the
  // review queue. The snapshot/label change here is also why
  // components/payments/invoice-detail-dialog.tsx's isVoided check (and its
  // STATUS_STYLES map) were updated in the same change to also recognize
  // 'Cancelled', not just 'Voided'.
  const { data: before } = await supabaseAdmin
    .from('payments')
    .select('id, qb_invoice_id, status, invoice_status, amount_due, amount_paid, paid_date, credit_remaining')
    .eq('id', paymentId)
    .maybeSingle()
  if (!before) return { success: false, error: 'Payment not found' }
  const preVoidState = capturePreVoidState(before)

  return safeAction(async () => {
    const now = new Date().toISOString()

    // Fixed 2026-09-07 (E2E QA sweep round 2, Senior Engineer + Bug-Hunter,
    // independently): this had no row-count check — a stale dialog (the row's
    // real status moved on between opening it and clicking Void, e.g. the
    // bank-feed matcher settled it, or a second tab/machine changed it first)
    // silently matched zero rows here, yet fell straight through into the
    // bank-feed-release logic below and reported success, undoing a real
    // match while the payments row itself was never touched. Mirrors the
    // check this file's own markInvoicePaid already has, a few lines above.
    // eslint-disable-next-line no-restricted-syntax -- legacy raw write; tracked by dev_task 7ebb1e0c
    const { data: voidedRows, error } = await supabaseAdmin
      .from('payments')
      .update({
        invoice_status: 'Cancelled',
        status: 'Cancelled',
        // Free the idempotency slot, mirroring the offer-cancel cascade: a voided tranche part
        // must be re-raisable, and a keyed corpse blocks the re-mint (council blocker, 2026-08-11).
        idempotency_key: null,
        updated_at: now,
      })
      .eq('id', paymentId)
      .in('invoice_status', ['Draft', 'Sent', 'Overdue'])
      .select('id')

    if (error) throw new Error(error.message)
    if (!voidedRows || voidedRows.length === 0) {
      throw new Error('This invoice changed before the void landed — it may no longer be Draft, Sent, or Overdue. Refresh and check its current state before trying again.')
    }

    // QB sync removed — QB is now one-way manual via the CRM finance "Push to QuickBooks" button.

    // Unlink bank feeds — same rule as Finance's voidInvoice: a transaction with a CONFIRMED
    // application to this invoice keeps its link (the money stays attributed to where it
    // actually went); everything else, only a suggestion, returns to the review queue.
    const { data: linkedFeeds, error: feedReadErr } = await supabaseAdmin
      .from('td_bank_feeds')
      .select('id, status')
      .eq('matched_payment_id', paymentId)
    if (feedReadErr) throw new Error(`Failed to read bank feeds: ${feedReadErr.message}`)

    const { listConfirmedApplications } = await import('@/lib/finance/apply-payment')
    const fundedFeedIds = new Set((await listConfirmedApplications(paymentId)).map((a) => a.feed_id))
    const releasable = (linkedFeeds ?? []).filter((f) => !fundedFeedIds.has(f.id))
    const { resetIds, clearIds } = partitionFeedsForUnlink(releasable)

    if (resetIds.length > 0) {
      const { error: resetErr } = await supabaseAdmin.from('td_bank_feeds').update({
        matched_payment_id: null, match_confidence: null, status: 'unmatched', updated_at: now,
      }).in('id', resetIds)
      if (resetErr) throw new Error(`Failed to unlink bank feeds: ${resetErr.message}`)
    }
    if (clearIds.length > 0) {
      const { error: clearErr } = await supabaseAdmin.from('td_bank_feeds').update({
        matched_payment_id: null, match_confidence: null, updated_at: now,
      }).in('id', clearIds)
      if (clearErr) throw new Error(`Failed to clear bank feed suggestions: ${clearErr.message}`)
    }

    revalidatePath('/payments')
    // Finance reads the same payments table on its own Invoices tab —
    // revalidate both while the old Payment Tracker page still exists
    // (dev job ef5da377).
    revalidatePath('/finance')
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice voided/cancelled + bank feeds unlinked',
    // Read back by reactivateInvoice. Do not rename this key.
    details: { pre_void_state: preVoidState },
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

    // Delete the client-portal mirror first, if one exists (fixed 2026-09-06,
    // dev job ef5da377) — a Draft invoice already billed to a client account
    // gets a client_expenses row at creation, and the database refuses to
    // delete a payments row that mirror still points at. Shared with
    // deletePayment (Finance/Account page) so this can't drift out of sync
    // again — see lib/portal/td-invoice-mirror.ts for why every step here
    // must check its own error rather than continuing past a failure.
    await deleteClientExpenseMirror(paymentId)

    // Delete items first — this FK does NOT cascade (confirmed live 2026-09-06,
    // dev job ef5da377: the equivalent gap in deletePayment failed on exactly
    // this table once its own mirror-cleanup bug was fixed) — so this must be
    // checked, not assumed to succeed.
    const { error: itemsErr } = await supabase.from('payment_items').delete().eq('payment_id', paymentId)
    if (itemsErr) throw new Error(`Deleting the invoice's line items failed: ${itemsErr.message}`)

    // Delete payment — re-checks Draft here too, not just on the read above:
    // the two are separate steps in the same request, so a status change
    // landing in between (e.g. a Send firing concurrently) must not let an
    // already-Sent invoice through.
    const { error } = await supabase
      .from('payments')
      .delete()
      .eq('id', paymentId)
      .eq('invoice_status', 'Draft')
    if (error) throw new Error(error.message)

    revalidatePath('/payments')
    // Finance reads the same payments table on its own Invoices tab —
    // revalidate both while the old Payment Tracker page still exists
    // (dev job ef5da377).
    revalidatePath('/finance')
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
