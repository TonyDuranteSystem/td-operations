import { z } from 'zod'
import { ACCOUNT_STATUS, COMPANY_TYPE } from '@/lib/constants'

export const createAccountSchema = z.object({
  company_name: z.string().min(1, 'Company name is required').max(300),
  entity_type: z.enum(COMPANY_TYPE).optional(),
  state_of_formation: z.string().max(50).optional(),
  status: z.enum(ACCOUNT_STATUS).default('Pending Formation'),
  ein_number: z.string().max(20).optional(),
  notes: z.string().optional(),
})

export type CreateAccountInput = z.infer<typeof createAccountSchema>
