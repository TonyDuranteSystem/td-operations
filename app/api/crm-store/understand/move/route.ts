/** POST — move ONE file to another client's / person's storage (staff, owners while only study copies exist).
 *  Body { fileId, toFolderId, analysisId? } → lands hidden and unshared. POST { undo: decisionId } puts it back. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../browse/_auth"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  try {
    if (typeof body.undo === "string") {
      const { moveDecisionFile, undoMove } = await import("@/lib/crm-store/understand/move-owner")
      const movedFile = await moveDecisionFile(body.undo)
      if (!movedFile) return NextResponse.json({ error: "Not found" }, { status: 404 })
      const e1 = await denyUnlessStorePilotEnv({ study: true, fileId: movedFile }); if (e1) return e1
      const na = await denyUnlessAreaAccess({ fileId: movedFile }); if (na) return na
      await undoMove(body.undo, user.id)
      return NextResponse.json({ ok: true })
    }
    const fileId = typeof body.fileId === "string" ? body.fileId : ""
    const toFolderId = typeof body.toFolderId === "string" ? body.toFolderId : ""
    if (!fileId || !toFolderId) return NextResponse.json({ error: "Say which file and which folder." }, { status: 400 })
    const env = await denyUnlessStorePilotEnv({ study: true, fileId }); if (env) return env
    const dest = await denyUnlessStorePilotEnv({ study: true, folderId: toFolderId }); if (dest) return dest
    const noAccess = (await denyUnlessAreaAccess({ fileId })) ?? (await denyUnlessAreaAccess({ folderId: toFolderId }))
    if (noAccess) return noAccess
    const { moveFileToOwner } = await import("@/lib/crm-store/understand/move-owner")
    return NextResponse.json(await moveFileToOwner({ fileId, toFolderId, actor: user.id, analysisId: typeof body.analysisId === "string" ? body.analysisId : null }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be moved." }, { status: 400 })
  }
}
