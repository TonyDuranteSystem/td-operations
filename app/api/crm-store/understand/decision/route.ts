/** POST — record what staff did with a File Understanding suggestion { analysisId, action: applied|changed|dismissed|linked|moved }.
 *  The change itself was made by Set type / Rename / Remove; this checks the file's real state, records it and teaches the system. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../browse/_auth"

// "moved" / "linked" are written by the move tool and the analysis themselves — a caller cannot claim them
const ACTIONS = new Set(["applied", "changed", "dismissed"])

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const analysisId = typeof body.analysisId === "string" ? body.analysisId : ""
  const action = typeof body.action === "string" && ACTIONS.has(body.action) ? body.action : ""
  if (!analysisId || !action) return NextResponse.json({ error: "Say which suggestion and what was done." }, { status: 400 })
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: a } = await (supabaseAdmin as any).from("store_file_analysis").select("file_id").eq("id", analysisId).maybeSingle()
  if (!a) return NextResponse.json({ error: "That reading no longer exists." }, { status: 404 })
  // a decision only RECORDS: allowed wherever the new storage is studied (sandbox pilot, or production's study copy)
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  const { studyCopyAllowed } = await import("@/lib/crm-store/drive-import")
  if (!pilotEnvironmentAllowed() && !studyCopyAllowed()) return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
  const noAccess = await denyUnlessAreaAccess({ fileId: a.file_id })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  try {
    const { recordDecision } = await import("@/lib/crm-store/understand/decisions")
    return NextResponse.json(await recordDecision({ analysisId, action: action as "applied", actor: user.id }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The decision could not be saved." }, { status: 400 })
  }
}
