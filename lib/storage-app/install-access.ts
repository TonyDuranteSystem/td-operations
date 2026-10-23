/** Who sees the CRM page "TD Storage install" and may download the app: an admin, or a staff member on the Mac-app allow-list (Antonio, 2026-10-22). Nobody else — not even other staff. */
import type { User } from "@supabase/supabase-js"
import { isAdmin } from "@/lib/auth"
import { isStoreStaffUser } from "@/lib/crm-store/access"
import { isOnAllowList, loadAllowList } from "./allow-list"

export async function canSeeInstallPage(user: User | null): Promise<boolean> {
  if (!user || !isStoreStaffUser(user)) return false
  return isAdmin(user) || isOnAllowList(user.email, await loadAllowList())
}
