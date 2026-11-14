import { NextRequest } from "next/server"
import { requireAdminRoute } from "@/lib/auth/require-admin-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { searchPeople } from "@/lib/booking/person"
import { fail, ok } from "@/lib/booking/route-helpers"

/** Booking page: the person picker. Admin only. */
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const denied = await requireAdminRoute()
  if (denied) return denied
  const r = await searchPeople(supabaseAdmin, req.nextUrl.searchParams.get("q"))
  if ("error" in r) return fail(500, r.error)
  return ok({ hits: r.hits })
}
