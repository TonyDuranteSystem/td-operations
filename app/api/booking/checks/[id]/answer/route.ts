import { NextRequest } from "next/server"
import { requireAdminJsonRoute } from "@/lib/auth/require-admin-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { answerCheck } from "@/lib/booking/checks"
import { BAD_BODY, currentAdmin, fail, ok, readJsonObject } from "@/lib/booking/route-helpers"

/** Calendar tab "Calls to check": Antonio's answer to one card. Admin only. Body: { answer: "same_person" | "different_person" | "dismiss" }. */
export const dynamic = "force-dynamic"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdminJsonRoute(req)
  if (denied) return denied
  const { id } = await params
  const body = await readJsonObject(req)
  if (!body) return fail(400, BAD_BODY)
  const who = await currentAdmin()
  const r = await answerCheck({ db: supabaseAdmin, by: who.email }, id, body.answer)
  if ("error" in r) return fail(r.status, r.error)
  return ok({ message: r.message })
}
