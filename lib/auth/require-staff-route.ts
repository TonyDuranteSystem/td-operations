/**
 * The canonical staff gate for an API route.
 *
 * WHY THIS EXISTS: `/api/*` is deliberately excluded from the middleware's client-role bounce
 * (`isDashboardPath` in middleware.ts returns false for anything under /api), so an API route
 * inherits only "is logged in" — NOT "is staff". A portal CLIENT has a login. Any staff route
 * that reads or writes with the service-role client and forgets its own check is therefore
 * reachable by a client.
 *
 * That is not hypothetical: an audit on 2026-07-21 found three service-role staff routes with no
 * check at all (agent-decisions, inbox/templates, addresses). Before this helper, four routes had
 * each hand-rolled their own local `requireStaff` — so there was nothing canonical for a fifth
 * route to reach for. This is that thing.
 *
 * Usage — first line of every staff route handler:
 *   const denied = await requireStaffRoute()
 *   if (denied) return denied
 *
 * NOT for client-portal routes: those serve clients by design and must scope by the caller's own
 * account (see lib/portal/portal-auth.ts), not by staff-ness.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"

/**
 * Returns a 403 response to hand straight back, or null when the caller is staff.
 * Deny-by-default: any failure to establish a staff identity is a denial.
 */
export async function requireStaffRoute(): Promise<NextResponse | null> {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }
    return null
  } catch {
    // Never fail OPEN: if the identity check itself breaks, refuse.
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }
}
