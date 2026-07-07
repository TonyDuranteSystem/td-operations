import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"

/**
 * Access control for the inbox's Gmail mailboxes.
 *
 * support@ is the shared team mailbox — any dashboard user may work it.
 * antonio@ is Antonio's PERSONAL mailbox — admin only. Enforced SERVER-SIDE
 * on every /api/inbox route that accepts a `mailbox` parameter (hiding the
 * UI toggle is not a security boundary).
 */

export const PERSONAL_MAILBOX = "antonio"

/** Pure decision — unit-testable. */
export function mailboxAllowedFor(
  mailbox: string | null | undefined,
  userIsAdmin: boolean
): boolean {
  if (mailbox === PERSONAL_MAILBOX) return userIsAdmin
  return true
}

/**
 * Server-side gate for /api/inbox routes. Resolves the session user and
 * checks the requested mailbox. Fails CLOSED (no user → not allowed) for
 * the personal mailbox.
 */
export async function checkMailboxAccess(
  mailbox: string | null | undefined
): Promise<boolean> {
  if (mailbox !== PERSONAL_MAILBOX) return true
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    return mailboxAllowedFor(mailbox, isAdmin(user))
  } catch {
    return false
  }
}
