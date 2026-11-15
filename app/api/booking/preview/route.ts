import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { judgeLink } from "@/lib/booking/make-link"
import { parseQuestionsChoice } from "@/lib/booking/plan"
import { loadTemplates, templateFor } from "@/lib/booking/templates"
import { BAD_BODY, fail, ok, personRefFrom, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: "When it gets booked, the system will:" for the choices on the page. Reads only, nothing is saved. Any staff (administrator or team). */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const body = await readJsonObject(req)
  const person = body ? personRefFrom(body.person) : null
  if (!body || !person || typeof body.kindSlug !== "string") return fail(400, BAD_BODY)
  const j = await judgeLink(supabaseAdmin, { person, kindSlug: body.kindSlug, minutes: body.minutes, firstBookingOnly: body.firstBookingOnly === true, questions: parseQuestionsChoice(body.questions) })
  if ("errors" in j) return ok({ ok: false, errors: j.errors })
  const templates = await loadTemplates(supabaseAdmin)
  const ready = !!templateFor(templates, j.judged.plan.template)
  return ok({ ok: true, lines: j.judged.lines, once: j.judged.plan.once, minutes: j.judged.plan.minutes, ready, template: j.judged.plan.template, autoTemplate: j.judged.plan.autoTemplate })
}
