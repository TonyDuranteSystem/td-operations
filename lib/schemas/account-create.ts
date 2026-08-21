import { z } from 'zod'
import { ACCOUNT_STATUS, COMPANY_TYPE, CREATABLE_ACCOUNT_TYPE, MEMBER_STRUCTURE } from '@/lib/constants'

export const createAccountSchema = z.object({
  company_name: z.string().min(1, 'Company name is required').max(300),
  entity_type: z.enum(COMPANY_TYPE, { message: 'Entity type is required' }),
  member_structure: z.enum(MEMBER_STRUCTURE, { message: 'Member structure is required' }),
  state_of_formation: z.string().min(1, 'State of formation is required').max(50),
  status: z.enum(ACCOUNT_STATUS).default('Pending Formation'),
  // 'Partner' is deliberately not offered at creation — see CREATABLE_ACCOUNT_TYPE.
  account_type: z.enum(CREATABLE_ACCOUNT_TYPE, { message: 'Role is required' }).default('Client'),
  ein_number: z.string().max(20).optional(),
  notes: z.string().optional(),
})

export type CreateAccountInput = z.infer<typeof createAccountSchema>

// Primary contact captured alongside a manually-created account. Name is
// split into parts (rather than one free-text field) because first/last
// name feed IRS forms, tax filings, and portal personalization elsewhere in
// the system — a naive space-split of one field was producing wrong results
// for multi-word names. Middle name has no dedicated column anywhere in the
// schema, so it's folded into the composed full name rather than stored
// separately (see createAndLinkContact).
export const primaryContactSchema = z.object({
  first_name: z.string().min(1, 'Primary contact first name is required').max(100),
  middle_name: z.string().max(100).optional(),
  last_name: z.string().min(1, 'Primary contact last name is required').max(100),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  address_line1: z.string().max(200).optional(),
  address_city: z.string().max(100).optional(),
  address_state: z.string().max(100).optional(),
  address_zip: z.string().max(20).optional(),
  address_country: z.string().max(100).optional(),
})

export type PrimaryContactInput = z.infer<typeof primaryContactSchema>
