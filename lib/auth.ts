import type { User } from "@supabase/supabase-js"
import { isStaffAuthRole } from "@/lib/team/workspace"

const ADMIN_EMAILS = ["antonio.durante@tonydurante.us"]

export type CrmRole = 'admin' | 'team'

/**
 * RBAC for CRM dashboard.
 * - Admin (Antonio): full access — financials, settings, all pages
 * - Team (support@, future staff): operational only — tasks, services, accounts
 * - Client: portal only (handled separately by isClient)
 */
export function isAdmin(user: User | null): boolean {
  if (!user) return false
  if (ADMIN_EMAILS.includes(user.email ?? "")) return true
  return user.app_metadata?.role === "admin" || user.user_metadata?.role === "admin"
}

/**
 * TAMPER-PROOF admin check for security-sensitive endpoints (the MFA reset,
 * and anything else where a false positive is a privilege escalation).
 * Unlike isAdmin(), this NEVER consults user_metadata — that object is
 * SELF-WRITABLE by the account holder via supabase.auth.updateUser, so
 * trusting its role would let any logged-in user grant themselves admin.
 * app_metadata is service-role-writable only; ADMIN_EMAILS is code.
 *
 * NOTE: isAdmin() itself still trusts user_metadata — that is a known,
 * separately-tracked security fix, deliberately NOT bundled into the MFA
 * ship. Never gate anything security-sensitive on isAdmin until it lands.
 */
export function isSecureAdmin(user: User | null): boolean {
  if (!user) return false
  if (ADMIN_EMAILS.includes(user.email ?? "")) return true
  return user.app_metadata?.role === "admin"
}

/** Accounts that may never be MFA-reset by anyone but themselves. */
export function isProtectedAdminEmail(email: string | null | undefined): boolean {
  return ADMIN_EMAILS.includes(email ?? "")
}

/**
 * My Finances (the owner's own private books) — Antonio's own account ONLY.
 * Deliberately stricter than isSecureAdmin(): a real account can legitimately
 * carry app_metadata.role === "admin" for OTHER admin-area testing/work
 * (e.g. the qa-staff@ account) without that meaning it should ever see
 * Antonio's own financial data. This checks the email itself, nothing else.
 */
export function isOwnerOnly(user: User | null): boolean {
  if (!user) return false
  return ADMIN_EMAILS.includes(user.email ?? "")
}

export function isTeam(user: User | null): boolean {
  if (!user) return false
  return !isClient(user) && !isAdmin(user)
}

export function isClient(user: User | null): boolean {
  if (!user) return false
  return user.app_metadata?.role === "client"
}

export function getCrmRole(user: User | null): CrmRole | null {
  if (!user) return null
  if (isAdmin(user)) return 'admin'
  if (!isClient(user)) return 'team'
  return null
}

export function getUserDisplayName(user: User): string {
  return user.user_metadata?.full_name || (user.email?.split("@")[0] ?? "User")
}

/** Check if user is any dashboard user (admin or team — NOT client) */
export function isDashboardUser(user: User | null): boolean {
  if (!user) return false
  return !isClient(user)
}

/**
 * Is this user TD STAFF? Stricter than `isDashboardUser`, which only excludes
 * clients and therefore lets a managed PARTNER through (Cris authenticates with
 * role 'partner' and is confined to /collab by middleware).
 *
 * Use this — not isDashboardUser — for anything that carries internal business
 * to a person: push registration, staff notification targeting, internal notes.
 * The rule itself lives in ONE place (isStaffAuthRole) so the server and the UI
 * can never disagree about who counts as staff.
 */
export function isStaffUser(user: User | null): boolean {
  if (!user) return false
  return isStaffAuthRole(user.app_metadata?.role)
}

/** Paths that require admin role. Team users are redirected to /. */
export const ADMIN_ONLY_PATHS = [
  '/dev-tools',
  '/team-management',
]
