import { z } from 'zod'
import { SERVICE_TYPE, SERVICE_STATUS } from '@/lib/constants'

export const createServiceSchema = z.object({
  account_id: z.string().uuid(),
  service_name: z.string().min(1).max(300),
  service_type: z.enum(SERVICE_TYPE),
  status: z.enum(SERVICE_STATUS).default('Not Started'),
  amount: z.number().optional(),
  amount_currency: z.enum(['USD', 'EUR']).default('USD'),
  total_steps: z.number().int().positive().optional(),
  notes: z.string().optional(),
})

export const updateServiceSchema = z.object({
  id: z.string().uuid(),
  updated_at: z.string(),
  service_name: z.string().min(1).max(300).optional(),
  service_type: z.enum(SERVICE_TYPE).optional(),
  status: z.enum(SERVICE_STATUS).optional(),
  current_step: z.number().int().min(0).optional(),
  total_steps: z.number().int().positive().optional(),
  amount: z.number().optional(),
  amount_currency: z.enum(['USD', 'EUR']).optional(),
  blocked_waiting_external: z.boolean().optional(),
  blocked_reason: z.string().optional(),
  sla_due_date: z.string().optional(),
  notes: z.string().optional(),
})

export type CreateServiceInput = z.infer<typeof createServiceSchema>
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>
