import { z } from 'zod'

/**
 * Deliberately its OWN item schema, not `invoiceItemSchema` from
 * `lib/schemas/invoice.ts` — a recurring line item repeats forever, so a
 * zero or negative unit price (a typo, with no creation UI to catch it
 * before this one existed) must be rejected at input time, not merely
 * detected after the fact by the generator's credit-note check. Antonio
 * (2026-08-17): recurring invoices are isolated from the existing
 * one-time/tranche/installment flow — this schema intentionally shares
 * nothing with `createInvoiceSchema`.
 */
export const recurringInvoiceItemSchema = z.object({
  description: z.string().min(1, 'Description required'),
  quantity: z.number().positive().default(1),
  unit_price: z.number().positive('Amount must be greater than zero'),
})

export const RECURRING_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const
export type RecurringInvoiceFrequency = (typeof RECURRING_FREQUENCIES)[number]

export const createRecurringInvoiceSchema = z
  .object({
    account_id: z.string().uuid(),
    label: z.string().min(1, 'A short internal name is required').max(200),
    description: z.string().min(1, 'Description required').max(500),
    amount_currency: z.enum(['USD', 'EUR']).default('USD'),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    frequency: z.enum(RECURRING_FREQUENCIES),
    payment_method: z.enum(['bank_transfer', 'card', 'both']).optional(),
    bank_preference: z.string().optional(),
    message: z.string().optional(),
    items: z.array(recurringInvoiceItemSchema).min(1, 'At least one line item required'),
  })

export type CreateRecurringInvoiceInput = z.infer<typeof createRecurringInvoiceSchema>

/**
 * Editable fields for an existing recurring schedule. Deliberately excludes
 * `next_run_date` and `active` — those stay owned by the cron's
 * success/failure invariant and the pause/resume toggle respectively;
 * letting staff hand-edit either would reopen the exact backlog-dump hazard
 * `fastForwardToNextOccurrence` exists to prevent (AI Architect + bug-hunter,
 * dev job ea5751ef). `account_id` is also excluded — re-billing an existing
 * schedule to a different client is a new schedule, not an edit.
 */
export const updateRecurringInvoiceSchema = z.object({
  label: z.string().min(1, 'A short internal name is required').max(200),
  description: z.string().min(1, 'Description required').max(500),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  due_date_offset_days: z.number().int().min(0),
  frequency: z.enum(RECURRING_FREQUENCIES),
  payment_method: z.enum(['bank_transfer', 'card', 'both']).optional(),
  bank_preference: z.string().optional(),
  message: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(recurringInvoiceItemSchema).min(1, 'At least one line item required'),
})

export type UpdateRecurringInvoiceInput = z.infer<typeof updateRecurringInvoiceSchema>
