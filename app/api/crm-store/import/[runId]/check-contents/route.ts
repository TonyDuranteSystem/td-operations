/** POST — "Check contents" on a finished copy (owners only): the File Understanding layer reads what is inside each
 *  stored file, the AI says what it is, green/red is decided by proofs, and look-alike files are listed. It records what it
 *  found; it NEVER retypes, renames, moves or deletes — a person applies a suggestion. */
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
  if (!pilotEnvironmentAllowed() && !(studyCopyAllowed() && await runIsCopy(params.runId))) return NextResponse.json({ error: "Reading a copy's files is not switched on here." }, { status: 403 })
  try {
    const { understandRun } = await import("@/lib/crm-store/run-contents")
    return NextResponse.json(await understandRun(params.runId, user.id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The contents could not be checked." }, { status: 400 })
  }
}
