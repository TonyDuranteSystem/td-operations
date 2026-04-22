import { z } from 'zod'

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

export const INSTALLMENT_TYPES = [
  'Setup Fee',
  'Installment 1 (Jan)',
  'Installment 2 (Jun)',
  'Annual Payment',
  'One-Time Service',
  'Custom',
] as const

export type InstallmentType = (typeof INSTALLMENT_TYPES)[number]

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
  bank_preference: z.enum(['auto', 'relay', 'mercury', 'revolut', 'airwallex']).optional(),
  items: z.array(invoiceItemSchema).min(1, 'At least one line item required'),
  mark_as_paid: z.boolean().optional(),
  installment: z.enum(INSTALLMENT_TYPES).optional(),
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
