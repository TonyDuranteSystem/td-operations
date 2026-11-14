'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/auth'
import { prepareAmountEdit } from '@/lib/crm-lists/amounts'
import { updateAccountField } from './actions'

export interface ListAmountResult {
  success: boolean
  error?: string
  /** The saved number (null when the amount was cleared). */
  amount?: number | null
  /** The company's new updated_at, so the next edit on the same company is not mistaken for a stale one. */
  updatedAt?: string
}

/**
 * Save one amount typed into the Accounts or Contacts list: 1st Inst, 2nd Inst or (Contacts only) Setup fee.
 *
 * It is the SAME save the Account page uses (`updateAccountField`: refuses an edit made on a stale screen, writes the audit
 * log), so the Account page, the lists, the June billing job and the other readers of these fields all see the new amount. Added on top:
 * - staff only;
 * - a Closed / Cancelled / Offboarding company is refused HERE, on the server, from the company's CURRENT status
 *   (the lock on screen is a courtesy; this is the rule);
 * - a typed "1,250" / "1.250" is read properly (the raw save would have sent the text to a number column);
 * - after a save, both lists refresh (the Account page's own save only refreshes the Account page).
 * It changes what is billed from now on; it never touches a signed contract or an invoice already created.
 */
export async function saveListAmount(accountId: string, field: string, raw: string, updatedAt: string): Promise<ListAmountResult> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) return { success: false, error: 'Not allowed.' }

  const { data: account, error: readError } = await supabase.from('accounts').select('status').eq('id', accountId).maybeSingle()
  if (readError || !account) return { success: false, error: 'Could not find this company. Reload the page and try again.' }

  const prepared = prepareAmountEdit({ field, raw, status: account.status })
  if (!prepared.ok) return { success: false, error: prepared.error }

  const result = await updateAccountField(accountId, field, prepared.value, updatedAt)
  if (!result.success) return { success: false, error: result.error ?? 'Could not save. Please try again.' }

  revalidatePath('/accounts')
  revalidatePath('/contacts')

  const { data: fresh } = await supabase.from('accounts').select('updated_at').eq('id', accountId).maybeSingle()
  return { success: true, amount: prepared.amount, updatedAt: fresh?.updated_at ?? undefined }
}
