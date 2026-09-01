'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { runActivation } from '@/lib/operations/activate-service'
import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'
import {
  createInvoiceSchema,
  createCreditNoteSchema,
  type CreateInvoiceInput,
  type CreateCreditNoteInput,
} from '@/lib/schemas/invoice'
import { createTDInvoice } from '@/lib/portal/td-invoice'
import { applyAvailableCreditToInvoice } from '@/lib/operations/credit-netting'
import { createHash } from 'crypto'
import { PLAN_TOTAL_TOLERANCE, validatePaymentPlan } from '@/lib/offers/payment-plan'
import { resolveTrancheCardFeeRate } from '@/lib/offers/payment-plan-state'

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
): Promise<ActionResult<{ id: string; invoice_number: string; duplicate_warning?: string }>> {
  const parsed = createInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }

  const { items, ...invoiceData } = parsed.data
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const total = subtotal - (invoiceData.discount || 0)

  // ⛔ TWO DIFFERENT NOTIONS OF "THE SAME INVOICE", and a part of a payment plan needs the
  // second one.
  //
  // For an ordinary manual invoice, sameness is the CONTENT — two clicks with identical figures
  // are one invoice, and changing a figure legitimately makes a different one.
  //
  // For a part of a plan, sameness is the PART ITSELF. Keying on content would let part two be
  // raised twice by editing the amount between clicks, which is precisely the double-bill this
  // is meant to prevent. The database index is the hard guarantee; this key makes the second
  // attempt return the FIRST invoice instead of surfacing a constraint error to whoever clicked.
  const idempotencyKey = invoiceData.tranche
    ? `offer-tranche:${invoiceData.tranche.offer_token}:${invoiceData.tranche.seq}`
    : manualInvoiceIdempotencyKey(
        'manual-crm-invoice',
        invoiceData.account_id,
        items,
        invoiceData.description,
        total,
        invoiceData.amount_currency,
        invoiceData.issue_date,
      )

  return safeAction(async () => {
    // ⛔ A RAISED PART MUST MATCH WHAT THE PLAN ACTUALLY PROMISED (2026-08-13) — nothing checked
    // this before. The form is free text: a mistyped amount here would let a part read as fully
    // paid on less (or more) cash than the plan states, and — now that a plan's referrer/partner
    // commission is released once the whole plan is genuinely settled — a short part could make
    // the deal LOOK complete while the client owes more, or a long part could overstate what a
    // referrer's commission should be based on. Checked against the SAME tolerance the rest of
    // the plan math uses, so this can never be a stricter or looser opinion than any other rail.
    if (invoiceData.tranche) {
      // ⛔ NO DISCOUNT ON A PLAN PART (2026-08-14, bug-hunter, code-level pass) — the part's
      // agreed amount already IS the definitive figure; a discount on top of it is a second,
      // conflicting way of stating what's owed. Found reachable: this screen's discount field
      // renders unconditionally even in tranche mode. The check above compares `total`
      // (subtotal MINUS discount) against the plan — correctly — but the actual invoice this
      // creates is NOT told about the discount at all (createTDInvoice takes only line items),
      // so the persisted invoice and its PDF show the FULL undiscounted amount while this guard
      // saw the discounted one. That gap let a mismatched real invoice sail through a check that
      // had just "confirmed" it matched — and the inflated total would then overstate a
      // referrer's or partner's commission, computed from the real invoice, not the form. If a
      // client genuinely needs a discount on a part, change the PLAN'S part amount and re-raise,
      // so there is one number, not two.
      if ((invoiceData.discount || 0) > 0) {
        throw new Error(
          "A part of a payment plan cannot carry a separate discount — the plan's part amount is " +
          "already the figure owed. To reduce it, edit the plan on the offer, then raise again.",
        )
      }
      const planQuery = supabaseAdmin
        .from('offers')
        .select('payment_plan' as never)
        .eq('token', invoiceData.tranche.offer_token) as unknown as {
          maybeSingle: () => Promise<{ data: { payment_plan?: unknown } | null }>
        }
      const { data: offerRow } = await planQuery.maybeSingle()
      const parsed = validatePaymentPlan(offerRow?.payment_plan)
      const part = parsed.ok && parsed.plan ? parsed.plan.find((p) => p.seq === invoiceData.tranche!.seq) : undefined
      // ⛔ CURRENCY, NOT JUST AMOUNT (2026-08-14, bug-hunter, 6th pass) — the currency dropdown on
      // this screen is fully editable even in tranche mode, and a number can agree with the plan
      // while the currency silently doesn't (e.g. 1000 EUR raised against a part agreed at 1000
      // USD). The amount check below cannot catch this — it compares bare numbers — and a
      // currency-blind total then feeds directly into the settlement sum a referrer's or
      // partner's commission is computed from. Checked first: comparing amounts across different
      // currencies is meaningless anyway.
      if (part && part.currency !== invoiceData.amount_currency) {
        throw new Error(
          `Part ${part.seq} of this plan is agreed in ${part.currency} — this invoice is in ` +
          `${invoiceData.amount_currency}. They must match. Fix the currency, or fix the plan on the offer, then raise again.`,
        )
      }
      if (part && Math.abs(total - part.amount) > PLAN_TOTAL_TOLERANCE) {
        throw new Error(
          `Part ${part.seq} of this plan is agreed at ${part.amount} — this invoice totals ${total}. ` +
          `They must match. Fix the amount, or fix the plan on the offer, then raise again.`,
        )
      }
      // No matching part or an unparsable plan: not this guard's job to invent an opinion about
      // — createTDInvoice and the money rails downstream already handle a plan that doesn't
      // validate. Silently proceeding here matches that existing, deliberate degrade.
    }

    // A later PART of a plan inherits the OFFER's pinned card-fee rate (council, 2026-08-11).
    // Shared with the auto-raise cron — see resolveTrancheCardFeeRate's own doc comment for why
    // this must not be a second, hand-rolled copy.
    const inheritedCardFeeRate = invoiceData.tranche
      ? await resolveTrancheCardFeeRate(invoiceData.tranche.offer_token)
      : undefined
    const result = await createTDInvoice({
      account_id: invoiceData.account_id,
      line_items: items.map((item) => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: invoiceData.amount_currency as 'USD' | 'EUR',
      due_date: invoiceData.due_date || undefined,
      issue_date: invoiceData.issue_date,
      message: invoiceData.message || undefined,
      installment: invoiceData.installment || undefined,
      // Billing year for the installment badge + duplicate check (both keyed on
      // account + payment_category + year) — derived from the issue date, since
      // this dialog has no separate year field. Was silently never sent before
      // this fix, so a real installment invoice had no year on it at all.
      year: invoiceData.installment ? Number(invoiceData.issue_date.slice(0, 4)) : undefined,
      idempotency_key: idempotencyKey,
      // ⛔ These three were being silently dropped — the dialog collects and
      // sends them, but nothing ever forwarded them to createTDInvoice, so
      // "Mark as Paid" saved a Draft, a chosen payment method saved null,
      // and a chosen bank fell back to auto-selection, all while the UI
      // reported success as requested (bug-hunter finding, dev job
      // ea5751ef). The Finance-tab equivalent action already did this
      // correctly — this call site was the one that didn't.
      mark_as_paid: invoiceData.mark_as_paid || undefined,
      payment_method: invoiceData.payment_method || undefined,
      bank_preference: invoiceData.bank_preference || undefined,
      ...(invoiceData.tranche
        ? {
            tranche_offer_token: invoiceData.tranche.offer_token,
            tranche_seq: invoiceData.tranche.seq,
            // Its own category, never an instalment one: paying an instalment lifts the
            // accountant hand-off gate and feeds the June cron. A split setup fee must touch
            // neither.
            payment_category: 'setup_tranche',
            ...(inheritedCardFeeRate !== undefined ? { card_fee_rate: inheritedCardFeeRate } : {}),
          }
        : {}),
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
    return { id: result.paymentId, invoice_number: result.invoiceNumber, duplicate_warning: result.duplicate_warning }
  }, {
    action_type: 'create',
    table_name: 'payments',
    account_id: invoiceData.account_id,
    summary: invoiceData.tranche
      ? `Invoice created (Draft) — part ${invoiceData.tranche.seq} of a payment plan`
      : `Invoice created (Draft)`,
    details: {
      total,
      currency: invoiceData.amount_currency,
      items_count: items.length,
      ...(invoiceData.tranche ? { tranche: invoiceData.tranche } : {}),
    },
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

      // Trigger activate-service directly (no HTTP hop). Awaited so failures
      // are logged; PR B will route failures to the CRM bank-feed review queue.
      try {
        const activateResult = await runActivation(pendingAct.id)
        if (!activateResult.ok) {
          console.error(`[invoice-mark-paid] runActivation returned error for pending ${pendingAct.id}: ${activateResult.error}`)
        }
      } catch (err) {
        console.error(`[invoice-mark-paid] runActivation threw for pending ${pendingAct.id}:`, err)
      }
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
        // Free the idempotency slot, mirroring the offer-cancel cascade: a voided tranche part
        // must be re-raisable, and a keyed corpse blocks the re-mint (council blocker, 2026-08-11).
        idempotency_key: null,
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
      issue_date: noteData.issue_date,
      mark_as_paid: true,
      paid_date: noteData.issue_date,
      idempotency_key: idempotencyKey,
      skip_credit_netting: true, // this IS a credit note — must not net into itself
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
        credit_remaining: Math.abs(total), // available to net against future invoices
        credit_for_payment_id: noteData.credit_for_payment_id || null,
        referral_partner_id: noteData.referral_partner_id || null,
      })
      .eq('id', result.paymentId)

    // Click-to-apply (2026-06-03): credits are NOT auto-applied at creation. The
    // credit sits as available credit_remaining and lands on whichever invoice
    // staff click Regenerate on (regenerateInvoice). This prevents a credit from
    // silently reducing the oldest/overdue invoice instead of the intended one.
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

// ── Regenerate Invoice (click-to-apply credit) ─────────────────────
// Generic for ANY account-scoped invoice/service. Click-to-apply model
// (2026-06-03): credits are NOT auto-applied at creation — they sit as available
// credit_remaining on the account. Clicking Regenerate on an invoice applies the
// account's available credit to THIS invoice (up to what is still owed), shows it
// as a "Credit applied −$X" line, drops amount_due, and consumes the credit
// (stamping credit_for_payment_id = this invoice). The invoice you click is the
// invoice the credit lands on. No money moves and the invoice number is unchanged.
// Idempotent: a re-click with no remaining available credit re-renders the same
// document (newApply = 0). amount_paid tracks REAL cash only — credit is shown as
// a line, never folded into amount_paid.
export async function regenerateInvoice(paymentId: string): Promise<ActionResult<{ invoice_number: string | null; applied_credit: number; new_total: number; mirror_synced?: boolean }>> {
  return safeAction(async () => {
    const supabase = createClient()
    const result = await applyAvailableCreditToInvoice(paymentId, supabase)
    revalidatePath('/payments')
    return result
  }, {
    action_type: 'update',
    table_name: 'payments',
    record_id: paymentId,
    summary: 'Invoice regenerated — applied available credit (click-to-apply)',
  })
}

// ── Create One-Time Customer (Phase 3) ─────────────────────────────
// Quick-creates a contact + account for ad-hoc / one-time clients not yet in the system.

export interface CreateOneTimeCustomerInput {
  first_name: string
  last_name: string
  email: string
  company?: string
  currency?: 'USD' | 'EUR'
}

export async function createOneTimeCustomer(
  input: CreateOneTimeCustomerInput,
): Promise<ActionResult<{ accountId: string; accountName: string }>> {
  if (!input.first_name?.trim()) return { success: false, error: 'First name required' }
  if (!input.email?.trim()) return { success: false, error: 'Email required' }

  return safeAction(async () => {
    const supabase = createClient()
    const companyName = input.company?.trim()
      || `${input.first_name.trim()} ${input.last_name.trim()}`.trim()
    const fullName = `${input.first_name.trim()} ${input.last_name.trim()}`.trim()

    // Check if a contact with this email already exists — reuse if so.
    const { data: existingContact } = await supabase
      .from('contacts')
      .select('id')
      .eq('email', input.email.trim().toLowerCase())
      .maybeSingle()

    let contactId: string

    if (existingContact) {
      contactId = existingContact.id
    } else {
      // eslint-disable-next-line no-restricted-syntax
      const { data: newContact, error: contactErr } = await supabaseAdmin
        .from('contacts')
        .insert({
          first_name: input.first_name.trim(),
          last_name: input.last_name.trim() || null,
          email: input.email.trim().toLowerCase(),
          full_name: fullName,
        })
        .select('id')
        .single()
      if (contactErr || !newContact) throw new Error(contactErr?.message ?? 'Failed to create contact')
      contactId = newContact.id
    }

    // Check if an account already exists for this email / company to avoid duplicates.
    const { data: existingAccount } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name')
      .eq('communication_email', input.email.trim().toLowerCase())
      .maybeSingle()

    if (existingAccount) {
      return { accountId: existingAccount.id, accountName: existingAccount.company_name }
    }

    // Create the account.
    // eslint-disable-next-line no-restricted-syntax
    const { data: newAccount, error: accountErr } = await supabaseAdmin
      .from('accounts')
      .insert({
        company_name: companyName,
        account_type: 'Client',
        status: 'Active',
        communication_email: input.email.trim().toLowerCase(),
        installment_1_currency: input.currency ?? 'USD',
        installment_2_currency: input.currency ?? 'USD',
        // One-time customers have no portal login — null overrides the DB
        // default of 'active' so resolveInvoiceAudience returns 'no_portal'
        // and the email gets bank details + card button instead of portal CTA.
        portal_tier: null,
      })
      .select('id, company_name')
      .single()

    if (accountErr || !newAccount) throw new Error(accountErr?.message ?? 'Failed to create account')

    // Link contact to account.
    await supabaseAdmin
      .from('account_contacts')
      .insert({ account_id: newAccount.id, contact_id: contactId, role: 'Owner' })

    revalidatePath('/accounts')
    return { accountId: newAccount.id, accountName: newAccount.company_name }
  }, {
    action_type: 'create',
    table_name: 'accounts',
    summary: `One-time customer created: ${input.first_name} ${input.last_name}`,
    details: { email: input.email, company: input.company },
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
