/**
 * Pure decision logic for cleaning up duplicate portal logins for one contact.
 *
 * A contact should have exactly ONE auth login — the one matching their primary
 * (canonical) email. Stray logins (a different email pointing at the same
 * contact, e.g. created by an offer that used a different address) are orphans
 * to delete.
 *
 * SAFETY (destructive op): if NO login matches the canonical email, delete
 * NOTHING — never leave a contact with zero logins. Emit a warning for manual
 * review instead. Pure/total so the keep-vs-delete decision is unit-tested
 * before any irreversible auth deletion runs.
 */

export interface AuthLogin {
  id: string
  email: string | null
}

export interface LoginCleanupPlan {
  /** The login to keep (canonical), or null when none matched the primary email. */
  keepId: string | null
  /** Stray login ids to delete. Empty when there's nothing to clean or no canonical match. */
  deleteIds: string[]
  canonicalEmail: string
  /** Set when the plan deliberately deletes nothing despite extra logins. */
  warning?: string
}

export function planLoginCleanup(logins: AuthLogin[], canonicalEmail: string): LoginCleanupPlan {
  const canon = (canonicalEmail || "").toLowerCase().trim()
  const canonical = canon ? logins.find(l => (l.email || "").toLowerCase().trim() === canon) : undefined

  if (!canonical) {
    return {
      keepId: null,
      deleteIds: [],
      canonicalEmail,
      warning:
        logins.length > 0
          ? "No login matches the contact's primary email — nothing deleted (manual review needed)."
          : undefined,
    }
  }

  return {
    keepId: canonical.id,
    deleteIds: logins.filter(l => l.id !== canonical.id).map(l => l.id),
    canonicalEmail,
  }
}
