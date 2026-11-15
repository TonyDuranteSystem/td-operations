import { NextRequest } from "next/server"
import { requireBookingStaffRoute, requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { makeLink } from "@/lib/booking/make-link"
import { listLinks } from "@/lib/booking/links"
import { parseQuestionsChoice } from "@/lib/booking/plan"
import { BAD_BODY, currentAdmin, fail, ok, paymentFrom, personRefFrom, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: "Links I made" (GET) and making a new link, free or paid (POST). Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function GET() {
  const denied = await requireBookingStaffRoute()
  if (denied) return denied
  const r = await listLinks(supabaseAdmin, new Date(), 100, undefined, calendlyCtxFromEnv())
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
  const payment = body ? paymentFrom(body.payment) : null
  if (!body || !person || !payment || !payment.ok || typeof body.kindSlug !== "string") return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await makeLink(
    { db: supabaseAdmin, calendly: calendlyCtxFromEnv(), createdBy: who.email },
    { person, kindSlug: body.kindSlug, minutes: body.minutes, firstBookingOnly: body.firstBookingOnly === true, questions: parseQuestionsChoice(body.questions), payment: payment.value },
  )
  if ("errors" in r) return fail(422, r.errors.join(" "), { errors: r.errors, ...(r.needsConfirm ? { needsConfirm: true } : {}) })
  return ok({ link: r.link, lines: r.lines })
}
