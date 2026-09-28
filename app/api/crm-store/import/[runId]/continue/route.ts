/** POST — move the next batch of files of a running move (owners only). Call again while status is "moving". */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (!pilotEnvironmentAllowed()) return NextResponse.json({ error: "Moving a company to the new storage is not switched on here." }, { status: 403 })
  try {
    const { continueDriveImport } = await import("@/lib/crm-store/drive-import")
    return NextResponse.json(await continueDriveImport(params.runId, user.id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The move could not continue." }, { status: 400 })
  }
}
