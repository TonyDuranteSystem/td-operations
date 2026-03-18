import type { User } from "@supabase/supabase-js"

const ADMIN_EMAILS = ["antonio.durante@tonydurante.us"]

/**
 * Simple admin check for 2-user system (Antonio = admin, Luca = operator).
 * No permission matrix. Check at render time in components that need it.
 */
export function isAdmin(user: User | null): boolean {
  if (!user) return false
  if (ADMIN_EMAILS.includes(user.email ?? "")) return true
  return user.user_metadata?.role === "admin"
}

export function getUserDisplayName(user: User): string {
  return user.email?.split("@")[0] ?? "User"
}
