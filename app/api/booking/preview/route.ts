import { NextRequest } from "next/server"
import { requireAdminJsonRoute } from "@/lib/auth/require-admin-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { judgeLink } from "@/lib/booking/make-link"
import { loadTemplates, templateFor } from "@/lib/booking/templates"
import { BAD_BODY, fail, ok, personRefFrom, readJsonObject } from "@/lib/booking/route-helpers"

/** Booking page: "When it gets booked, the system will:" for the choices on the page. Reads only, nothing is saved. Admin only. */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  const denied = await requireAdminJsonRoute(req)
  if (denied) return denied
  const body = await readJsonObject(req)
  const person = body ? personRefFrom(body.person) : null
  if (!body || !person || typeof body.kindSlug !== "string") return fail(400, BAD_BODY)
  const j = await judgeLink(supabaseAdmin, { person, kindSlug: body.kindSlug, minutes: body.minutes, firstBookingOnly: body.firstBookingOnly === true })
  if ("errors" in j) return ok({ ok: false, errors: j.errors })
  const templates = await loadTemplates(supabaseAdmin)
  const ready = !!templateFor(templates, j.judged.plan.template)
  return ok({ ok: true, lines: j.judged.lines, once: j.judged.plan.once, minutes: j.judged.plan.minutes, ready })
}
