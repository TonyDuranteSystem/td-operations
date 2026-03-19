import { z } from 'zod'

export const createCustomerSchema = z.object({
  account_id: z.string().uuid(),
  name: z.string().min(1, 'Customer name is required'),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  vat_number: z.string().optional(),
  notes: z.string().optional(),
})

export const invoiceItemSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  quantity: z.number().min(0.01, 'Quantity must be greater than 0'),
  unit_price: z.number().min(0, 'Price must be 0 or greater'),
  amount: z.number(),
  sort_order: z.number().default(0),
})

export const createInvoiceSchema = z.object({
  account_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  currency: z.enum(['USD', 'EUR']),
  discount: z.number().min(0).default(0),
  issue_date: z.string(),
  due_date: z.string().optional(),
  notes: z.string().optional(),
  message: z.string().optional(),
  recurring_frequency: z.enum(['monthly', 'quarterly', 'yearly']).nullable().optional(),
  recurring_end_date: z.string().nullable().optional(),
  items: z.array(invoiceItemSchema).min(1, 'At least one line item is required'),
})

export const updateInvoiceSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().uuid(),
  customer_id: z.string().uuid().optional(),
  currency: z.enum(['USD', 'EUR']).optional(),
  discount: z.number().min(0).optional(),
  issue_date: z.string().optional(),
  due_date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
  status: z.enum(['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled']).optional(),
  paid_date: z.string().optional().nullable(),
  items: z.array(invoiceItemSchema).optional(),
})

// Template schemas
export const templateItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().min(0.01),
  unit_price: z.number().min(0),
})

export const createTemplateSchema = z.object({
  account_id: z.string().uuid(),
  name: z.string().min(1, 'Template name is required').max(100),
  customer_id: z.string().uuid().optional().nullable(),
  currency: z.enum(['USD', 'EUR']),
  items: z.array(templateItemSchema).min(1),
  message: z.string().optional().nullable(),
})

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>
