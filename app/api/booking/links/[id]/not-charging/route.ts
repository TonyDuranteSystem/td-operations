import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { stopCharging } from "@/lib/booking/pay-actions"
import { fail, ok } from "@/lib/booking/route-helpers"

/**
 * Booking page: "Not charging" on an unpaid paid call — the card closes and the payment page stops taking money. Any staff (administrator or team).
 * The ONE changing route that is NOT refused while the Booking switch is off (bug-hunter round 2, 15 Nov 2026): the switch does not stop a paid link that was already sent,
 * so switching Booking off must never take away the way to stop the money. It only ever STOPS charging; it cannot make, send or charge anything.
 */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const { id } = await params
  const r = await stopCharging(supabaseAdmin, id, new Date())
  if ("error" in r) return fail(r.status, r.error)
  return ok({ message: r.message })
}
