/**
 * The ONE gate for every Booking-page route (Stage 1b onward): ADMIN ONLY. The Booking page can make Calendly links, cancel a real Calendly event and send a payment
 * email, so it is stricter than requireStaffRoute (which lets any non-client through, including a partner or marketing login that middleware merely confines).
 *
 * WHY a shared helper and not a per-route check: `/api/*` inherits only "is logged in" from the middleware (a team login such as support@ is let in), so the check inside the
 * route is the ONLY wall. A text scan that merely finds the word "isSecureAdmin" would pass on dead code or a check made after the first database read; this helper is
 * the first statement of the handler, answers 403 with no-store, and denies when the identity check itself throws.
 *
 * Usage — first statement of every booking route handler:
 *   const denied = await requireAdminRoute()                       // GET / read-only
 *   const denied = await requireAdminJsonRoute(req)                // POST / PUT / PATCH / DELETE: also proves the request came from our own page
 *   if (denied) return denied
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSecureAdmin } from "@/lib/auth"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

const deny = (status: number, error: string): NextResponse =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } })

/** null = the caller is an admin; otherwise the response to hand straight back. Deny-by-default. */
export async function requireAdminRoute(): Promise<NextResponse | null> {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!isSecureAdmin(user ?? null)) return deny(403, "Not authorized")
    return null
  } catch {
    // never fail OPEN: if the identity check itself breaks, refuse
    return deny(403, "Not authorized")
  }
}

/** For routes that change something: the admin check first, then the same-origin JSON proof (a form or link on another site cannot forge it). */
export async function requireAdminJsonRoute(req: { headers: { get(name: string): string | null } }): Promise<NextResponse | null> {
  const denied = await requireAdminRoute()
  if (denied) return denied
  try {
    if (!isSameOriginJson(req.headers, req.headers.get("host") ?? "")) return deny(403, "Not allowed from here")
    return null
  } catch {
    return deny(403, "Not allowed from here")
  }
}
