/**
 * CRM Store — who may use the new storage (foundation slice 1).
 *
 * An explicit ALLOW-list, not the app-wide "everyone except client/partner"
 * blocklist (lib/team/workspace.ts `isStaffAuthRole`, which treats an empty
 * role as staff). A user with no role, or a role nobody has thought about,
 * is refused here. Reads only the server-set `app_metadata.role` — never
 * `user_metadata`, which the user can edit.
 *
 * The database side is stricter still: the store_* tables have RLS on with no
 * policies, so only the service role (behind routes that call this) can reach
 * them. Master plan v4.4 §8.4.
 */

import type { User } from "@supabase/supabase-js"

export const STORE_STAFF_ROLES = ["admin", "team"] as const
export type StoreStaffRole = (typeof STORE_STAFF_ROLES)[number]

export function isStoreStaffRole(role: unknown): role is StoreStaffRole {
  if (typeof role !== "string") return false
  return (STORE_STAFF_ROLES as readonly string[]).includes(role.trim().toLowerCase())
}

export function isStoreStaffUser(user: Pick<User, "app_metadata"> | null | undefined): boolean {
  if (!user) return false
  return isStoreStaffRole(user.app_metadata?.role)
}
