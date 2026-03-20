import { z } from 'zod'
import { DEAL_STAGE, SERVICE_TYPE } from '@/lib/constants'

export const createDealSchema = z.object({
  deal_name: z.string().min(1, 'Deal name is required').max(300),
  account_id: z.string().uuid(),
  stage: z.enum(DEAL_STAGE).default('Initial Consultation'),
  amount: z.number().optional(),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  service_type: z.enum(SERVICE_TYPE).optional(),
  deal_type: z.string().optional(),
  close_date: z.string().optional(),
  notes: z.string().optional(),
})

export const updateDealSchema = z.object({
  id: z.string().uuid(),
  updated_at: z.string(),
  deal_name: z.string().min(1).max(300).optional(),
  stage: z.enum(DEAL_STAGE).optional(),
  amount: z.number().optional(),
  amount_currency: z.enum(['USD', 'EUR']).optional(),
  service_type: z.enum(SERVICE_TYPE).optional(),
  deal_type: z.string().optional(),
  close_date: z.string().optional(),
  payment_status: z.string().optional(),
  notes: z.string().optional(),
})

export type CreateDealInput = z.infer<typeof createDealSchema>
export type UpdateDealInput = z.infer<typeof updateDealSchema>
