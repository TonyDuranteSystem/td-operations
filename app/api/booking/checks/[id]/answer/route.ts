import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { answerCheck } from "@/lib/booking/checks"
import { BAD_BODY, currentAdmin, fail, ok, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page, section "Calls to check": Antonio's answer to one card. Any staff (administrator or team). Body: { answer: "same_person" | "different_person" | "dismiss" }. */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const { id } = await params
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await answerCheck({ db: supabaseAdmin, by: who.email }, id, body.answer)
  if ("error" in r) return fail(r.status, r.error)
  return ok({ message: r.message })
}
