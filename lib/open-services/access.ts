/**
 * Open services tab — the access rule (pure; no database).
 *
 *   off     → nobody.
 *   all     → TD staff with an EXPLICIT role (isStaffUser: not a client, not a managed partner, AND a role is set —
 *             an account with no role at all counts as legacy staff elsewhere in the CRM, but not for this page).
 *   owners  → TD staff who are owners (isOwnerOnly: Antonio, plus NEXT_PUBLIC_EXTRA_OWNER_EMAILS when set on that
 *             deployment — on production that variable may be unset, so 'owners' can mean Antonio alone).
 *
 * Deliberately NOT isAdmin(): it trusts user_metadata.role, which the account holder can write to their own login
 * (lib/auth.ts:36-53 says never to gate anything sensitive on it).
 */

import type { User } from "@supabase/supabase-js"
import { isOwnerOnly, isStaffUser } from "@/lib/auth"
import type { Audience } from "@/lib/open-services/audience-shared"

/** The page does not trust a missing role (the CRM's deny-list treats it as legacy staff): a role must be written down. */
function hasExplicitRole(user: User): boolean {
  const role = user.app_metadata?.role
  return typeof role === "string" && role.trim() !== ""
}

export function canViewOpenServices(user: User | null, audience: Audience): boolean {
  if (!user) return false
  if (audience === "off") return false
  if (!hasExplicitRole(user) || !isStaffUser(user)) return false
  if (audience === "all") return true
  if (audience === "owners") return isOwnerOnly(user)
  return false
}
