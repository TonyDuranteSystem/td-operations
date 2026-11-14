import { NextRequest } from "next/server"
import { requireAdminJsonRoute } from "@/lib/auth/require-admin-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { changeKind } from "@/lib/booking/kinds-admin"
import { BAD_BODY, currentAdmin, fail, ok, readJsonObject } from "@/lib/booking/route-helpers"

/** Booking page: rename, retire or restore a kind. Admin only. Body: { rename?: string, status?: "active" | "retired" }. */
export const dynamic = "force-dynamic"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireAdminJsonRoute(req)
  if (denied) return denied
  const { slug } = await params
  const body = await readJsonObject(req)
  if (!body || (body.rename === undefined && body.status === undefined)) return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await changeKind(supabaseAdmin, slug, { rename: body.rename, status: body.status }, who.id)
  if ("error" in r) return fail(r.status, r.error)
  return ok({ kind: r.kind })
}
