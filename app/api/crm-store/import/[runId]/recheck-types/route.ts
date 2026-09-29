/** POST — "Re-check types" on a finished move (owners only): files stored without a type get the type their
 *  record's label now means (answered type questions). */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (!pilotEnvironmentAllowed()) return NextResponse.json({ error: "Moving a company to the new storage is not switched on here." }, { status: 403 })
  try {
    const { recheckRunTypes, runView } = await import("@/lib/crm-store/drive-import")
    const r = await recheckRunTypes(params.runId, user.id)
    return NextResponse.json({ ...r, run: await runView(params.runId) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The types could not be re-checked." }, { status: 400 })
  }
}
