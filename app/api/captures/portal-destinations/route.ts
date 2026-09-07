import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"
import { searchPortalDestinations } from "@/lib/captures/portal-destinations"
import { NextRequest, NextResponse } from "next/server"

/**
 * GET /api/captures/portal-destinations?q=<search>
 *
 * Staff-only (isStaffUser, not isDashboardUser — this carries internal
 * business straight to a person, per lib/auth.ts's own guidance). Returns
 * every real send target for the typed search: see
 * lib/captures/portal-destinations.ts for the full shape and the two
 * filters (closed accounts, never-onboarded contacts) this endpoint applies
 * that no earlier Phase-1 picker needed.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const q = request.nextUrl.searchParams.get("q") ?? ""
  const candidates = await searchPortalDestinations(q)
  return NextResponse.json({ candidates })
}
