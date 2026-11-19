import { NextRequest } from "next/server"
import { requireBookingStaffRoute, requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { addKind, listKinds } from "@/lib/booking/kinds-admin"
import { BAD_BODY, currentAdmin, fail, ok, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: the kinds of link (GET) and adding one (POST). Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  const r = await listKinds(supabaseAdmin)
  if ("error" in r) return fail(500, r.error)
  return ok({ kinds: r.kinds })
}

export async function POST(req: NextRequest) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await addKind(supabaseAdmin, { name: body.name, choice: body.choice }, who.id)
  if ("error" in r) return fail(r.status, r.error)
  return ok({ kind: r.kind })
}
