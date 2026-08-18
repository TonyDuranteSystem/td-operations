"use server"

import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { safeAction, type ActionResult } from "@/lib/server-action"
import { createRecurringInvoiceSchema, updateRecurringInvoiceSchema, type CreateRecurringInvoiceInput, type UpdateRecurringInvoiceInput } from "@/lib/schemas/recurring-invoice"
import { generateRecurringInvoiceCycle, type RecurringInvoiceTemplateRow } from "@/lib/billing/recurring-invoice-generate"
import { fastForwardToNextOccurrence, type RecurringFrequency } from "@/lib/billing/recurring-invoice-schedule"
import { getOfficeDateString } from "@/lib/portal/office-hours"

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
): Promise<ActionResult<{ templateId: string; paymentId?: string; invoiceNumber?: string; generationError?: string; deferredToDate?: string }>> {
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

      const today = getOfficeDateString()

      // A FUTURE issue date must not generate a bill today — the resulting
      // invoice would be dated before it was ever created. Leave the
      // template due on its own next_run_date (= the chosen issue date); the
      // cron picks it up naturally the day it actually arrives, exactly like
      // any other cycle (senior-engineer finding, dev job ea5751ef).
      if (data.issue_date > today) {
        revalidatePath("/payments")
        revalidatePath("/finance")
        return { templateId: tmplRow.id as string, deferredToDate: data.issue_date }
      }

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
  updated_at: string
}

export async function listRecurringInvoiceTemplates(): Promise<RecurringTemplateListRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data, error } = await (supabaseAdmin as any)
    .from("recurring_invoice_templates")
    .select(
      "id, label, description, frequency, currency, line_items, active, next_run_date, last_generated_at, last_run_status, updated_at, accounts:account_id(company_name), contacts:contact_id(full_name)",
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
      updated_at: row.updated_at as string,
    }
  })
}

export interface RecurringTemplateEditRow {
  id: string
  label: string
  description: string | null
  frequency: RecurringFrequency
  currency: "USD" | "EUR"
  due_date_offset_days: number
  payment_method: string | null
  bank_preference: string | null
  message: string | null
  notes: string | null
  items: Array<{ description: string; unit_price: number; quantity: number }>
  updated_at: string
  last_generated_at: string | null
}

export async function getRecurringInvoiceTemplateForEdit(id: string): Promise<RecurringTemplateEditRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data, error } = await (supabaseAdmin as any)
    .from("recurring_invoice_templates")
    .select(
      "id, label, description, frequency, currency, due_date_offset_days, payment_method, bank_preference, message, notes, line_items, updated_at, last_generated_at",
    )
    .eq("id", id)
    .single()

  if (error || !data) throw new Error(error?.message || "Recurring schedule not found")

  const items = (data.line_items as Array<{ description: string; unit_price: number; quantity?: number }>) ?? []
  return {
    id: data.id,
    label: data.label,
    description: data.description,
    frequency: data.frequency,
    currency: data.currency,
    due_date_offset_days: data.due_date_offset_days,
    payment_method: data.payment_method,
    bank_preference: data.bank_preference,
    message: data.message,
    notes: data.notes,
    items: items.map((i) => ({ description: i.description, unit_price: i.unit_price, quantity: i.quantity ?? 1 })),
    updated_at: data.updated_at,
    last_generated_at: data.last_generated_at,
  }
}

export async function updateRecurringInvoiceTemplate(
  id: string,
  expectedUpdatedAt: string,
  input: UpdateRecurringInvoiceInput,
): Promise<ActionResult<{ next_run_date_changed: boolean }>> {
  const parsed = updateRecurringInvoiceSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message }
  const data = parsed.data

  return safeAction(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { data: current, error: readErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .select("updated_at, next_run_date, frequency")
        .eq("id", id)
        .single()
      if (readErr || !current) throw new Error(readErr?.message || "Recurring schedule not found")
      if (current.updated_at !== expectedUpdatedAt) {
        throw new Error("This schedule was changed elsewhere since you opened it — reload and try again.")
      }

      const today = getOfficeDateString()
      let nextRunDate: string | undefined
      // A frequency change only matters for timing if the schedule hasn't
      // fired under the new cadence yet. If the current next bill date is
      // still due (overdue or today), catch it up the same proven way
      // reactivation does. If it's still in the future under the OLD
      // frequency, that stale future date no longer means anything under
      // the new one — reset the anchor to today so the edit takes effect on
      // the next cron run instead of silently waiting out the old cadence
      // for up to a full cycle (bug-hunter + senior-engineer finding, dev
      // job ea5751ef).
      if (data.frequency !== current.frequency) {
        nextRunDate = current.next_run_date <= today
          ? fastForwardToNextOccurrence(current.next_run_date as string, data.frequency, today)
          : today
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { error: updErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .update({
          label: data.label,
          description: data.description,
          currency: data.amount_currency,
          due_date_offset_days: data.due_date_offset_days,
          frequency: data.frequency,
          payment_method: data.payment_method || null,
          bank_preference: data.bank_preference || null,
          message: data.message || null,
          notes: data.notes || null,
          line_items: data.items.map((i) => ({ description: i.description, unit_price: i.unit_price, quantity: i.quantity })),
          updated_at: new Date().toISOString(),
          ...(nextRunDate ? { next_run_date: nextRunDate } : {}),
        })
        .eq("id", id)
      if (updErr) throw new Error(updErr.message)

      revalidatePath("/finance")
      return { next_run_date_changed: !!nextRunDate }
    },
    { action_type: "update", table_name: "recurring_invoice_templates", record_id: id, summary: `Recurring schedule "${data.label}" edited` },
  )
}

export async function deleteRecurringInvoiceTemplate(id: string): Promise<ActionResult<{ deactivated: boolean }>> {
  return safeAction(
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { data: current, error: readErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .select("last_generated_at, label")
        .eq("id", id)
        .single()
      if (readErr || !current) throw new Error(readErr?.message || "Recurring schedule not found")

      // A template that has already generated at least one real invoice is
      // never hard-deleted — payments has no back-reference to this table,
      // so deleting it would leave those invoices with zero queryable trail
      // explaining why they exist. Deactivating (the same effect as the
      // pause toggle) is the only "remove it" action once a schedule has
      // fired (AI architect + senior-engineer, dev job ea5751ef).
      if (current.last_generated_at) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        const { error: updErr } = await (supabaseAdmin as any)
          .from("recurring_invoice_templates")
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq("id", id)
        if (updErr) throw new Error(updErr.message)
        revalidatePath("/finance")
        return { deactivated: true }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      const { error: delErr } = await (supabaseAdmin as any)
        .from("recurring_invoice_templates")
        .delete()
        .eq("id", id)
      if (delErr) throw new Error(delErr.message)

      revalidatePath("/finance")
      return { deactivated: false }
    },
    { action_type: "delete", table_name: "recurring_invoice_templates", record_id: id, summary: "Recurring schedule removed" },
  )
}

export async function toggleRecurringInvoice(templateId: string, active: boolean): Promise<ActionResult<{ next_run_date: string }>> {
  return safeAction(
    async () => {
      const now = new Date().toISOString()
      const today = getOfficeDateString()

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
