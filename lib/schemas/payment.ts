import { z } from 'zod'
import { PAYMENT_STATUS, PAYMENT_PERIOD } from '@/lib/constants'

export const createPaymentSchema = z.object({
  account_id: z.string().uuid(),
  description: z.string().min(1).max(500),
  amount: z.number().positive(),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(PAYMENT_STATUS).default('Pending'),
  period: z.enum(PAYMENT_PERIOD).optional(),
  year: z.number().optional(),
  payment_method: z.string().optional(),
  notes: z.string().optional(),
})

export const updatePaymentSchema = z.object({
  id: z.string().uuid(),
  updated_at: z.string(),
  description: z.string().min(1).max(500).optional(),
  amount: z.number().positive().optional(),
  amount_currency: z.enum(['USD', 'EUR']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(PAYMENT_STATUS).optional(),
  period: z.enum(PAYMENT_PERIOD).optional(),
  year: z.number().optional(),
  payment_method: z.string().optional(),
  paid_date: z.string().optional(),
  notes: z.string().optional(),
  followup_stage: z.string().nullable().optional(),
  delay_approved_until: z.string().nullable().optional(),
})

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>
