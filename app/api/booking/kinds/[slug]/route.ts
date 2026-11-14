import { NextRequest } from "next/server"
import { requireBookingStaffJsonRoute } from "@/lib/auth/require-booking-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { changeKind } from "@/lib/booking/kinds-admin"
import { BAD_BODY, currentAdmin, fail, ok, readJsonObject, refuseWhileOff } from "@/lib/booking/route-helpers"

/** Booking page: rename, retire or restore a kind. Any staff (administrator or team). Body: { rename?: string, status?: "active" | "retired" }. */
export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireBookingStaffJsonRoute(req)
  if (denied) return denied
  const off = await refuseWhileOff()
  if (off) return off
  const { slug } = await params
  const body = await readJsonObject(req)
  if (!body || (body.rename === undefined && body.status === undefined)) return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await changeKind(supabaseAdmin, slug, { rename: body.rename, status: body.status }, who.id)
  if ("error" in r) return fail(r.status, r.error)
  return ok({ kind: r.kind })
}
