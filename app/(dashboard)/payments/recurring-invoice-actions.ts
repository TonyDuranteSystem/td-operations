"use server"

import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { safeAction, type ActionResult } from "@/lib/server-action"
import { createRecurringInvoiceSchema, type CreateRecurringInvoiceInput } from "@/lib/schemas/recurring-invoice"
import { generateRecurringInvoiceCycle, type RecurringInvoiceTemplateRow } from "@/lib/billing/recurring-invoice-generate"
import { fastForwardToNextOccurrence, type RecurringFrequency } from "@/lib/billing/recurring-invoice-schedule"

/**
 * Recurring invoices are DELIBERATELY ISOLATED from `createInvoice` (the
 * ordinary one-time/tranche/installment action) — Antonio (2026-08-17): "I
 * want a fucking option to create a recurring invoice that [has] nothing to
 * do with installments or other stuff that works today." No discount field,
 * no installment tag, no tranche/payment-plan linkage, no mark-as-paid, no
 * send-immediately. Just: account, description, line items, frequency.
 */

const TEMPLATE_SELECT =
  "id, account_id, contact_id, label, description, line_items, currency, frequency, next_run_date, end_date, due_date_offset_days, installment, payment_category, notes, message, bank_preference, payment_method"

export async function createRecurringInvoice(
  input: CreateRecurringInvoiceInput,
): Promise<ActionResult<{ templateId: string; paymentId?: string; invoiceNumber?: string; generationError?: string }>> {
  const parsed = createRecurringInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const data = parsed.data

  // A due date before the issue date has no sane offset — surface it instead
  // of silently clamping to "due same day" and repeating that forever
  // (bug-hunter finding, dev job 4a854806, third pass).
  if (data.due_date && data.due_date < data.issue_date) {
    return { success: false, error: "Due date can't be before the issue date." }
  }

  return safeAction(
    async () => {
      // due_date is picked relative to issue_date on the form; stored as a
      // day-count offset so every future cycle reuses the same gap.
      const dueDateOffsetDays = data.due_date
        ? Math.round((new Date(`${data.due_date}T00:00:00Z`).getTime() - new Date(`${data.issue_date}T00:00:00Z`).getTime()) / 86400000)
        : 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recurring_invoice_templates not yet in generated types (regenerated on production promotion)
      const { data: tmplRow, error: insErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .insert({
          account_id: data.account_id,
          label: data.label,
          description: data.description,
          line_items: data.items.map((i) => ({ description: i.description, unit_price: i.unit_price, quantity: i.quantity })),
          currency: data.amount_currency,
          frequency: data.frequency,
          // Schedule row is inserted FIRST, next_run_date = the chosen issue
          // date — then the shared generator (below) turns THIS row into
          // cycle one's invoice, exactly like the cron will for cycle two
          // onward. Never a second, separately-written "create the first
          // invoice" path (Council review, dev job 4a854806, third pass).
          next_run_date: data.issue_date,
          due_date_offset_days: dueDateOffsetDays,
          bank_preference: data.bank_preference || null,
          payment_method: data.payment_method || null,
          message: data.message || null,
          active: true,
          created_by: "recurring-invoice-dialog",
        })
        .select(TEMPLATE_SELECT)
        .single()

      if (insErr || !tmplRow) throw new Error(insErr?.message || "Failed to create the recurring schedule")

      const result = await generateRecurringInvoiceCycle(tmplRow as RecurringInvoiceTemplateRow)

      revalidatePath("/payments")
      revalidatePath("/finance")

      if (result.action === "error") {
        // The schedule itself was created successfully and stays due at the
        // ORIGINAL issue date — the next cron run retries cycle one
        // automatically, same self-healing behavior as any other failed
        // cycle. Deliberately does NOT fast-forward here: this cycle was
        // never actually generated, so advancing past it would skip a real
        // charge, not just catch up a schedule. Report the schedule as
        // created, but surface that the first bill didn't generate yet.
        return { templateId: tmplRow.id as string, generationError: result.detail }
      }

      // CATCH UP TO A REAL FUTURE DATE — only reached on a SUCCESSFUL first
      // cycle. generateRecurringInvoiceCycle only ever advances ONE cycle
      // from next_run_date; a backdated issue date (e.g. "match when the
      // service actually started" — completely ordinary on a one-time
      // invoice) would otherwise still land in the past, and the very next
      // cron run would pick this schedule straight back up and repeat once a
      // day until it caught up — the exact backlog-dump class already fixed
      // for re-activation, reopened through creation (bug-hunter finding,
      // dev job 4a854806, third pass). Reuses that same proven fast-forward
      // helper, computed from the ORIGINAL issue date so it always lands on
      // a real occurrence of the chosen cadence. Idempotent/no-op when the
      // issue date wasn't backdated: the result matches what the generator
      // already wrote.
      const today = new Date().toISOString().split("T")[0]
      const caughtUpNextRunDate = fastForwardToNextOccurrence(data.issue_date, data.frequency, today)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .update({ next_run_date: caughtUpNextRunDate, updated_at: new Date().toISOString() })
        .eq("id", tmplRow.id)

      return { templateId: tmplRow.id as string, paymentId: result.paymentId, invoiceNumber: result.invoiceNumber }
    },
    { action_type: "create", table_name: "recurring_invoice_templates", account_id: data.account_id, summary: `Created recurring schedule "${data.label}" (${data.frequency})` },
  )
}

export interface RecurringTemplateListRow {
  id: string
  label: string
  description: string | null
  frequency: RecurringFrequency
  currency: "USD" | "EUR"
  amount: number
  active: boolean
  next_run_date: string
  last_generated_at: string | null
  last_run_status: "ok" | "error" | null
  account_name: string | null
  contact_name: string | null
}

export async function listRecurringInvoiceTemplates(): Promise<RecurringTemplateListRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data, error } = await (supabaseAdmin as any)
    .from("recurring_invoice_templates")
    .select(
      "id, label, description, frequency, currency, line_items, active, next_run_date, last_generated_at, last_run_status, accounts:account_id(company_name), contacts:contact_id(full_name)",
    )
    .order("active", { ascending: false })
    .order("label", { ascending: true })

  if (error) throw new Error(error.message)

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const items = (row.line_items as Array<{ unit_price: number; quantity?: number }>) ?? []
    const amount = items.reduce((sum, i) => sum + i.unit_price * (i.quantity ?? 1), 0)
    const account = row.accounts as { company_name: string } | null
    const contact = row.contacts as { full_name: string } | null
    return {
      id: row.id as string,
      label: row.label as string,
      description: row.description as string | null,
      frequency: row.frequency as RecurringFrequency,
      currency: row.currency as "USD" | "EUR",
      amount,
      active: row.active as boolean,
      next_run_date: row.next_run_date as string,
      last_generated_at: row.last_generated_at as string | null,
      last_run_status: row.last_run_status as "ok" | "error" | null,
      account_name: account?.company_name ?? null,
      contact_name: contact?.full_name ?? null,
    }
  })
}

export async function toggleRecurringInvoice(templateId: string, active: boolean): Promise<ActionResult<{ next_run_date: string }>> {
  return safeAction(
    async () => {
      const now = new Date().toISOString()
      const today = now.split("T")[0]

      let nextRunDate: string | undefined
      if (active) {
        // Re-activating: fast-forward a stale next_run_date to the next
        // FUTURE occurrence so flipping this back on doesn't dump a burst of
        // backdated invoices (one per missed cycle) on the next cron pass
        // (bug-hunter finding, dev job 4a854806, third pass).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        const { data: current, error: readErr } = await (supabaseAdmin as any)
          .from("recurring_invoice_templates")
          .select("next_run_date, frequency")
          .eq("id", templateId)
          .single()
        if (readErr || !current) throw new Error(readErr?.message || "Recurring schedule not found")
        if (current.next_run_date <= today) {
          nextRunDate = fastForwardToNextOccurrence(current.next_run_date as string, current.frequency as RecurringFrequency, today)
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { error: updErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .update({ active, updated_at: now, ...(nextRunDate ? { next_run_date: nextRunDate } : {}) })
        .eq("id", templateId)
      if (updErr) throw new Error(updErr.message)

      revalidatePath("/finance")
      return { next_run_date: nextRunDate ?? "" }
    },
    { action_type: "update", table_name: "recurring_invoice_templates", record_id: templateId, summary: `Recurring schedule ${active ? "turned ON" : "turned OFF"}` },
  )
}
