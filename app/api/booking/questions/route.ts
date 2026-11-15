import { requireBookingStaffRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { CALENDLY_CALL_TYPES_URL, loadCallQuestions } from "@/lib/booking/questions"
import { ok } from "@/lib/booking/route-helpers"

/** Booking page: the questions each Calendly call type asks the booker, read from Calendly. Reads only. Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  const questions = await loadCallQuestions(supabaseAdmin, calendlyCtxFromEnv())
  return ok({ questions, editUrl: CALENDLY_CALL_TYPES_URL })
}
