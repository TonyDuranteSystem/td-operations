import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { markPaymentSent } from "@/lib/booking/pay-actions"
import { fail, ok, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: "I sent it" on an unpaid paid call — remembers the payment link was sent (nothing is sent from here). Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const { id } = await params
  const r = await markPaymentSent(supabaseAdmin, id, new Date())
  if ("error" in r) return fail(r.status, r.error)
  return ok({ message: r.message })
}
