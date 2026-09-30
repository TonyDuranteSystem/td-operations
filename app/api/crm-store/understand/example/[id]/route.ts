/** DELETE — retract a teaching example (a wrong correction stops counting at once). GET /api/crm-store/understand/example/scoreboard — the scoreboard. */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "../../../browse/_auth"

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  try {
    const { retractExample } = await import("@/lib/crm-store/understand/examples")
    await retractExample(params.id, user.id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not retract." }, { status: 400 })
  }
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  if (params.id !== "scoreboard") return NextResponse.json({ error: "Not found" }, { status: 404 })
  const { scoreboard } = await import("@/lib/crm-store/understand/examples")
  return NextResponse.json(await scoreboard())
}
