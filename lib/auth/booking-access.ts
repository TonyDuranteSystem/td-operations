/**
 * Who may open the Booking page (dev job a1839d8b). Pure, no I/O — shared by the page, the two route gates and the left menu so they can never disagree.
 *
 * Two named levels (each Booking route, page and section declares which it needs):
 *   - STAFF: an administrator or a team login. Exactly the logins that saw the Leads page before it moved into Booking: admin and team
 *     (lib/team/workspace.ts isStaffAuthRole's allow-list, app_metadata only) plus the protected administrator by email.
 *   - ADMIN: an administrator only (isSecureAdmin) — available for a section that must stay stricter.
 * A client, a partner, a marketing login, an unknown or empty role and a signed-out visitor are neither.
 */
import type { User } from "@supabase/supabase-js"
import { isSecureAdmin, isStaffUser } from "@/lib/auth"

/** An administrator or a team login. Never reads user_metadata (the account holder can write it). */
export function isBookingStaff(user: User | null): boolean {
  if (!user) return false
  return isSecureAdmin(user) || isStaffUser(user)
}
