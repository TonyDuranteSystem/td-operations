/**
 * The ONE function that turns a recurring_invoice_templates row into a real
 * invoice for a single cycle. Used by BOTH the daily cron
 * (app/api/cron/recurring-invoices/route.ts) and the "create recurring
 * invoice" action (app/(dashboard)/payments/recurring-invoice-actions.ts) for
 * the schedule's very first cycle — deliberately never two separate code
 * paths that could drift apart over time (Council review, dev job 4a854806,
 * third pass: the original plan had cycle 1 created through the ordinary
 * one-time invoice flow and cycle 2+ through the cron, which could silently
 * disagree on which fields — description, bank account — actually persist).
 *
 * Extracted, unmodified in behavior, from the cron route (already twice
 * adversarially bug-hunted there) — see that file's own history for the
 * incident record behind each guard below.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { emitRecurringInvoiceGeneratedEvent } from "@/lib/portal/chat-events"
import {
  addDaysToDate,
  buildTemplateFailureUpdate,
  buildTemplateSuccessUpdate,
  type RecurringFrequency,
} from "@/lib/billing/recurring-invoice-schedule"

export interface RecurringInvoiceTemplateRow {
  id: string
  account_id: string | null
  contact_id: string | null
  label: string
  description: string | null
  line_items: Array<{ description: string; unit_price: number; quantity?: number; tax_rate?: number }>
  currency: "USD" | "EUR"
  frequency: RecurringFrequency
  next_run_date: string
  end_date: string | null
  due_date_offset_days: number
  installment: string | null
  payment_category: string | null
  notes: string | null
  message: string | null
  bank_preference: string | null
  payment_method: string | null
}

export interface RecurringInvoiceCycleResult {
  action: "created" | "error"
  label: string
  detail: string
  paymentId?: string
  invoiceNumber?: string
}

/**
 * Generate one cycle for a due template. Does NOT check `active`/due-ness —
 * the caller (cron query, or the "generate cycle one now" action) decides
 * that; this function only knows how to turn a template row into an invoice
 * and record the outcome.
 */
export async function generateRecurringInvoiceCycle(tmpl: RecurringInvoiceTemplateRow): Promise<RecurringInvoiceCycleResult> {
  const runDate = tmpl.next_run_date
  const dueDate = addDaysToDate(runDate, tmpl.due_date_offset_days ?? 0)
  const idempotencyKey = `recurring-template:${tmpl.id}:${runDate}`
  const year = Number(runDate.slice(0, 4))

  try {
    const invoice = await createTDInvoice({
      account_id: tmpl.account_id || undefined,
      contact_id: tmpl.contact_id || undefined,
      line_items: tmpl.line_items,
      currency: tmpl.currency,
      due_date: dueDate,
      description: tmpl.description || undefined,
      notes: tmpl.notes || undefined,
      message: tmpl.message || undefined,
      bank_preference: tmpl.bank_preference || undefined,
      payment_method: tmpl.payment_method || undefined,
      idempotency_key: idempotencyKey,
      installment: tmpl.installment || undefined,
      payment_category: tmpl.payment_category || undefined,
      year,
    })

    // SUCCESS PATH ONLY past this point — next_run_date advances here and
    // nowhere else (buildTemplateSuccessUpdate is the only function that
    // ever sets it). A throw above skips straight to the catch block below,
    // which builds a failure update with no next_run_date field.
    //
    // The update itself is wrapped in its own try/catch, not left to a bare
    // `{error}` destructure: supabase-js normally RETURNS an error rather
    // than throwing, but a genuine network-level failure (not a DB-level
    // rejection) makes the underlying fetch reject instead. Left unguarded,
    // that reject would fall through to the OUTER catch below and mislabel
    // an invoice that was already successfully created as a generation
    // failure — skipping the credit-note check and the staff notification
    // entirely, both of which only run past this point (bug-hunter finding,
    // dev job 4a854806, third pass).
    let successUpdateErr: { message: string } | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recurring_invoice_templates not yet in generated types (regenerated on production promotion)
      const { error } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .update(
          buildTemplateSuccessUpdate({
            runDate,
            frequency: tmpl.frequency,
            paymentId: invoice.paymentId,
            now: new Date().toISOString(),
          }),
        )
        .eq("id", tmpl.id)
      successUpdateErr = error
    } catch (updateException) {
      successUpdateErr = { message: updateException instanceof Error ? updateException.message : String(updateException) }
    }

    if (successUpdateErr) {
      // The INVOICE was already created — this is a bookkeeping failure on a
      // real invoice, not a generation failure. Left unaddressed,
      // next_run_date never advances, so the next run re-selects this
      // template, hits createTDInvoice's own idempotency key, gets the SAME
      // invoice back, and reports "created" again — forever, looking healthy
      // while doing nothing. Surface it loudly instead of swallowing it.
      // Deliberately does NOT skip notification below — the invoice is real
      // and needs staff review/sending regardless of whether this
      // bookkeeping write landed.
      try {
        const { reportSystemError } = await import("@/lib/system-errors")
        await reportSystemError({
          source: "server",
          route: "recurring-invoices-cron/template-update-failed",
          message: `Recurring invoice ${invoice.invoiceNumber} was created from template "${tmpl.label}" but its schedule record failed to update (next_run_date did not advance) — this template will look due again tomorrow and must be fixed by hand.`,
          context: {
            template_id: tmpl.id,
            payment_id: invoice.paymentId,
            invoice_number: invoice.invoiceNumber,
            db_error: successUpdateErr.message,
          },
        })
      } catch (reportErr) {
        console.error(`[recurring-invoice-generate] reportSystemError itself failed for template ${tmpl.id}:`, reportErr)
      }
    }

    // A recurring TEMPLATE producing a credit note (createTDInvoice numbers
    // it CN- whenever the line items sum to <= 0) is almost certainly a
    // misconfigured line_items array — no legitimate recurring bill is zero
    // or negative. The row is real and the schedule still correctly
    // advances (there is nothing to retry), but this must NOT be announced
    // to staff as a routine invoice ready to send.
    const looksLikeCreditNote = invoice.invoiceNumber.startsWith("CN-")
    if (looksLikeCreditNote) {
      try {
        const { reportSystemError } = await import("@/lib/system-errors")
        await reportSystemError({
          source: "server",
          route: "recurring-invoices-cron/template-produced-credit-note",
          message: `Recurring template "${tmpl.label}" generated a credit note (${invoice.invoiceNumber}, total $${invoice.total}) instead of a bill on its scheduled run — its line items likely sum to zero or a negative amount. Check the template's line items.`,
          context: { template_id: tmpl.id, payment_id: invoice.paymentId, invoice_number: invoice.invoiceNumber },
        })
      } catch (reportErr) {
        console.error(`[recurring-invoice-generate] reportSystemError failed for credit-note template ${tmpl.id}:`, reportErr)
      }
    }

    try {
      await emitRecurringInvoiceGeneratedEvent({
        payment_id: invoice.paymentId,
        account_id: tmpl.account_id,
        contact_id: tmpl.contact_id,
        message: looksLikeCreditNote
          ? `Recurring template "${tmpl.label}" generated a credit note (${invoice.invoiceNumber}) instead of a bill — check its line items.`
          : `Recurring invoice ${invoice.invoiceNumber} ($${invoice.total} ${tmpl.currency}) generated from "${tmpl.label}" — release it.`,
      })
    } catch (notifyErr) {
      // Non-fatal — the invoice already exists; a missed notification must
      // never be treated as a missed charge.
      console.warn(`[recurring-invoice-generate] notify failed for template ${tmpl.id}:`, notifyErr)
    }

    const invoiceSummary = looksLikeCreditNote
      ? `${invoice.invoiceNumber} — credit note, not a bill (⚠️ check template line items)`
      : `${invoice.invoiceNumber} — $${invoice.total} ${tmpl.currency}`
    return {
      action: "created",
      label: tmpl.label,
      detail: successUpdateErr ? `${invoiceSummary} (⚠️ schedule update failed: ${successUpdateErr.message})` : invoiceSummary,
      paymentId: invoice.paymentId,
      invoiceNumber: invoice.invoiceNumber,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // FAILURE PATH — buildTemplateFailureUpdate has no next_run_date field,
    // so this template stays due and retries the same charge next time,
    // REGARDLESS of whether this bookkeeping write itself succeeds
    // (next_run_date is simply never touched on this path) — so a failure
    // here only loses diagnostic detail, not correctness. Still logged
    // loudly rather than swallowed. Wrapped in its own try/catch so a
    // network-level reject can never escape this function unhandled
    // (bug-hunter finding, dev job 4a854806, third pass) — the function
    // always returns a structured result either way.
    let failureUpdateErr: { message: string } | null = null
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { error } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .update(buildTemplateFailureUpdate({ errorMessage: message, now: new Date().toISOString() }))
        .eq("id", tmpl.id)
      failureUpdateErr = error
    } catch (updateException) {
      failureUpdateErr = { message: updateException instanceof Error ? updateException.message : String(updateException) }
    }
    if (failureUpdateErr) {
      console.error(`[recurring-invoice-generate] failed to record last_error for template ${tmpl.id}:`, failureUpdateErr.message)
    }

    // Surface loudly — a template failing every cycle with the outcome
    // recorded only on a column nobody browses is functionally the same as
    // silently never billing the client.
    try {
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({
        source: "server",
        route: "recurring-invoices-cron/generation-failed",
        message: `Recurring template "${tmpl.label}" failed to generate its scheduled invoice: ${message}. It stays due and will retry on the next run — if this keeps happening, the template needs fixing.`,
        context: { template_id: tmpl.id, run_date: runDate, error: message },
      })
    } catch (reportErr) {
      console.error(`[recurring-invoice-generate] reportSystemError failed for template ${tmpl.id}:`, reportErr)
    }

    return { action: "error", label: tmpl.label, detail: message }
  }
}
