/**
 * The "ANY STAFF" gate of the Booking page (dev job a1839d8b, 14 Nov 2026 — Antonio: "the staff, Luca and Jody, can see it"). The sibling of
 * lib/auth/require-admin-route.ts: every Booking route and the Booking page now declare which of the two they need —
 *   requireBookingStaffRoute / requireBookingStaffJsonRoute   → an administrator OR a team login (the two staff roles)
 *   requireAdminRoute / requireAdminJsonRoute                 → an administrator only (kept for any section that must stay stricter, e.g. paid links in Stage 3)
 *
 * WHO counts as staff here: exactly isStaffAuthRole's allow-list in app_metadata (admin, team) — the same rule the rest of the CRM uses — plus the protected
 * administrator by email. NOT `isDashboardUser` ("anyone who is not a client", which lets a partner or a marketing login through) and never user_metadata
 * (the account holder can write that object themselves). A login with an unknown or empty role is refused.
 *
 * WHY a shared helper and not a per-route check: `/api/*` inherits only "is logged in" from the middleware, so the check inside the route is the ONLY wall.
 * This helper is the first statement of the handler, answers 403 with no-store, and denies when the identity check itself throws (never fails open). Changing
 * routes also prove the request came from our own page (same-origin JSON), exactly like the admin gate.
 *
 * Usage — first statement of every staff-level booking route handler:
 *   const denied = await requireBookingStaffRoute()                // GET / read-only
 *   const denied = await requireBookingStaffJsonRoute(req)         // POST / PUT / PATCH / DELETE
 *   if (denied) return denied
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isBookingStaff } from "@/lib/auth/booking-access"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

const deny = (status: number, error: string): NextResponse =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } })

/** null = the caller is staff (admin or team); otherwise the response to hand straight back. Deny-by-default. */
export async function requireBookingStaffRoute(): Promise<NextResponse | null> {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!isBookingStaff(user ?? null)) return deny(403, "Not authorized")
    return null
  } catch {
    // never fail OPEN: if the identity check itself breaks, refuse
    return deny(403, "Not authorized")
  }
}

/** For routes that change something: the staff check first, then the same-origin JSON proof (a form or link on another site cannot forge it). */
export async function requireBookingStaffJsonRoute(req: { headers: { get(name: string): string | null } }): Promise<NextResponse | null> {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  try {
    if (!isSameOriginJson(req.headers, req.headers.get("host") ?? "")) return deny(403, "Not allowed from here")
    return null
  } catch {
    return deny(403, "Not allowed from here")
  }
}
