/**
 * TD Social — the icon number to send with an alert, for ONE person looked up by id (server; dev job 2072bc3e, Step 2 pull request C2).
 *
 * The same rules as "What may I see?" (lib/app/identity.ts) and the same counters (lib/app/counts.ts), but with no session: the person's login is read
 * from the auth admin API, their tabs come from the one tab list, and their Marketing context from their membership. A muted tab is not counted.
 * HONEST OR ABSENT: any failure or slowness returns null and the alert is sent WITHOUT a number (the phone keeps the one it has; the app corrects it when
 * opened). It never returns 0 for "could not count".
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin, isStaffUser } from "@/lib/auth"
import { normalizeRole } from "@/lib/auth/role-door"
import { memberContextForUser, type MarketingContext } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { tabsFor } from "@/lib/app/tabs"
import { readState } from "@/lib/app/state"
import { countTabs } from "@/lib/app/counts"

export async function badgeForUser(userId: string): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    const user = data?.user
    if (error || !user) return null
    const role = normalizeRole(user.app_metadata?.role)
    const admin = isAdmin(user)
    let marketing: MarketingContext | undefined
    if (admin || role === "marketing") {
      const g = await memberContextForUser({ id: user.id, email: user.email ?? null }, admin)
      if (g.ok === true && hasPermission(g.ctx.permissions, "chat")) marketing = g.ctx
    }
    const tabs = tabsFor({ authRole: role, isAdmin: admin, isStaff: isStaffUser(user), marketingChat: marketing !== undefined })
    if (tabs.length === 0) return null
    // a failed read is NOT the same as "no row yet": it would count muted tabs and miss the email baseline, so the number would be wrong. No number is the honest answer.
    const state = await readState(userId)
    const { badge } = await countTabs({ userId, tabs, mutedTabs: state?.muted_tabs ?? [], inboxOpened: state?.inbox_opened ?? {}, marketing })
    return badge
  } catch {
    return null
  }
}
