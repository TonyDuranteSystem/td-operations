import { NextRequest } from "next/server"
import { requireAdminJsonRoute } from "@/lib/auth/require-admin-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { revokeLink } from "@/lib/booking/links"
import { fail, ok } from "@/lib/booking/route-helpers"

/** Booking page: "Stop link". Admin only. */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminJsonRoute(req)
  if (denied) return denied
  const { id } = await params
  const r = await revokeLink(supabaseAdmin, id, new Date())
  if ("error" in r) return fail(r.status, r.error)
  return ok({ message: r.message })
}
