import { NextRequest } from "next/server"
import { requireBookingStaffRoute, requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { makeFreeLink } from "@/lib/booking/make-link"
import { listLinks } from "@/lib/booking/links"
import { BAD_BODY, currentAdmin, fail, ok, personRefFrom, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: "Links I made" (GET) and making a new FREE link (POST). Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  const r = await listLinks(supabaseAdmin, new Date())
  if ("error" in r) return fail(500, r.error)
  return ok({ links: r.links })
}

export async function POST(req: NextRequest) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const body = await readJsonObject(req)
  const person = body ? personRefFrom(body.person) : null
  if (!body || !person || typeof body.kindSlug !== "string") return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await makeFreeLink(
    { db: supabaseAdmin, calendly: calendlyCtxFromEnv(), createdBy: who.email },
    { person, kindSlug: body.kindSlug, minutes: body.minutes, firstBookingOnly: body.firstBookingOnly === true },
  )
  if ("errors" in r) return fail(422, r.errors.join(" "), { errors: r.errors })
  return ok({ link: r.link, lines: r.lines })
}
