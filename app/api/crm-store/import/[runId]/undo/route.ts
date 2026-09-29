/** POST — undo a move (owners only): CRM records back on their Drive files, moved files to the trash. */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function POST(_req: Request, { params }: { params: { runId: string } }) {
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  const { studyCopyAllowed, runIsCopy } = await import("@/lib/crm-store/drive-import")
  // the real move only where the pilot runs; a STUDY copy also where it is switched on (production)
  if (!pilotEnvironmentAllowed() && !(studyCopyAllowed() && await runIsCopy(params.runId))) return NextResponse.json({ error: "Moving a company to the new storage is not switched on here." }, { status: 403 })
  try {
    const { undoDriveImport } = await import("@/lib/crm-store/drive-import")
    return NextResponse.json(await undoDriveImport(params.runId, user.id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The move could not be undone." }, { status: 400 })
  }
}
