import { z } from 'zod'
import { INSTALLMENT_LABELS, installmentPairProblem } from '@/lib/billing/installment-invoice-key'

export const INVOICE_STATUS = [
  'Draft', 'Sent', 'Paid', 'Overdue', 'Voided', 'Credit',
] as const

export type InvoiceStatus = (typeof INVOICE_STATUS)[number]

export const invoiceItemSchema = z.object({
  description: z.string().min(1, 'Description required'),
  quantity: z.number().positive().default(1),
  unit_price: z.number(),
  amount: z.number(),
  sort_order: z.number().int().default(0),
})

// The ONLY Payment Types an invoice can still carry are the two yearly installments (see lib/billing/installment-invoice-key.ts):
// they are created from the CRM's installment amounts, never picked. One-off invoices carry no Payment Type, no hidden code and no year.
export const createInvoiceSchema = z.object({
  account_id: z.string().uuid(),
  description: z.string().min(1).max(500),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  discount: z.number().min(0).default(0),
  message: z.string().optional(),
  billing_entity_id: z.string().uuid().optional(),
  payment_method: z.enum(['bank_transfer', 'card', 'both']).optional(),
  bank_preference: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1, 'At least one line item required'),
  mark_as_paid: z.boolean().optional(),
  installment: z.enum(INSTALLMENT_LABELS).optional(),
  /** The year of the installment (the one the company page shows). Only with an installment, never guessed from a date. */
  year: z.number().int().min(2000).max(2100).optional(),
  /**
   * WS-C: this invoice is one PART of an offer's payment plan.
   *
   * Both fields or neither — the database enforces the pair. Its presence changes how the
   * invoice is deduplicated: the part's identity becomes the key, rather than a hash of the
   * amounts, because "part 2 of this offer" is what must exist only once. See the action.
   */
  tranche: z
    .object({
      offer_token: z.string().min(1),
      seq: z.number().int().positive(),
    })
    .optional(),
}).superRefine((v, ctx) => {
  const problem = installmentPairProblem({ installment: v.installment, year: v.year })
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

export const createCreditNoteSchema = z.object({
  account_id: z.string().uuid(),
  description: z.string().min(1).max(500),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  credit_for_payment_id: z.string().uuid().optional(),
  referral_partner_id: z.string().uuid().optional(),
  items: z.array(invoiceItemSchema).min(1, 'At least one line item required'),
})

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>
export type InvoiceItem = z.infer<typeof invoiceItemSchema>
