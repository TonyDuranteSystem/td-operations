import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Portal auth helpers. Uses app_metadata (server-only, tamper-proof)
 * instead of user_metadata (client-modifiable).
 *
 * Client users have:
 *   app_metadata.role = 'client'
 *   app_metadata.contact_id = uuid (links to contacts table)
 */

export function isClient(user: User | null): boolean {
  if (!user) return false
  return user.app_metadata?.role === "client"
}

export function getClientContactId(user: User): string | null {
  return user.app_metadata?.contact_id ?? null
}

/**
 * Get all account IDs a client can access.
 * A contact can be linked to multiple accounts via account_contacts junction.
 */
export async function getClientAccountIds(contactId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id")
    .eq("contact_id", contactId)

  return (data ?? []).map((row) => row.account_id)
}

/**
 * Check if a client user has access to a specific account.
 */
export async function clientCanAccessAccount(
  user: User,
  accountId: string
): Promise<boolean> {
  const contactId = getClientContactId(user)
  if (!contactId) return false

  const accountIds = await getClientAccountIds(contactId)
  return accountIds.includes(accountId)
}
