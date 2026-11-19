import { NextRequest } from "next/server"
import { requireBookingStaffRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { searchPeople } from "@/lib/booking/person"
import { fail, ok } from "@/lib/booking/route-helpers"

/** Booking page: the person picker. Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  const r = await searchPeople(supabaseAdmin, req.nextUrl.searchParams.get("q"))
  if ("error" in r) return fail(500, r.error)
  return ok({ hits: r.hits })
}
