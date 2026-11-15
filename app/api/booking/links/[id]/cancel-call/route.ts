import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { cancelLinkCall } from "@/lib/booking/cancel-call"
import { fail, ok, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: "Cancel the call" — cancels the booking made through one link, in Calendly (Calendly emails the booker). Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const { id } = await params
  const r = await cancelLinkCall({ db: supabaseAdmin, calendly: calendlyCtxFromEnv() }, id)
  if ("error" in r) return fail(r.status, r.error, r.cancelUrl ? { cancelUrl: r.cancelUrl } : {})
  return ok({ message: r.message })
}
