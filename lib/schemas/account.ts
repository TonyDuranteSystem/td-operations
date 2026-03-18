import { z } from "zod"
import { ACCOUNT_STATUS, COMPANY_TYPE } from "@/lib/constants"

export const updateAccountSchema = z.object({
  id: z.string().uuid(),
  updated_at: z.string(), // for optimistic locking
  company_name: z.string().min(1).max(200).optional(),
  entity_type: z.enum(COMPANY_TYPE).optional(),
  status: z.enum(ACCOUNT_STATUS).optional(),
  ein_number: z.string().max(20).optional(),
  state_of_formation: z.string().max(50).optional(),
  formation_date: z.string().optional(),
  physical_address: z.string().max(500).optional(),
  registered_agent: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
})

export const addNoteSchema = z.object({
  account_id: z.string().uuid(),
  note: z.string().min(1, "Note cannot be empty").max(2000),
})

export const updateContactSchema = z.object({
  id: z.string().uuid(),
  updated_at: z.string(), // for optimistic locking
  full_name: z.string().min(1).max(200).optional(),
  email: z.string().email("Invalid email").optional(),
  phone: z.string().max(30).optional(),
  language: z.enum(["English", "Italian"]).optional(),
  citizenship: z.string().max(100).optional(),
})

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>
export type AddNoteInput = z.infer<typeof addNoteSchema>
export type UpdateContactInput = z.infer<typeof updateContactSchema>
