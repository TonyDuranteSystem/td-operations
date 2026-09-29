/**
 * POST /api/crm-store/browse/trash/restore { batchId, targetFolderId? } — bring one deletion back from the trash.
 * Everything comes back HIDDEN from the client and unshared; the CRM listing comes back. If the original folder
 * is gone the answer is { needsTarget: true } and the screen asks where to put it. Staff only, pilot environment only.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../_auth"

export async function POST(req: NextRequest) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true }))
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { batchId?: unknown; targetFolderId?: unknown }
  if (typeof body.batchId !== "string") return NextResponse.json({ error: "Choose what to restore." }, { status: 400 })
  const target = typeof body.targetFolderId === "string" ? body.targetFolderId : null
  try {
    const { ownerOfBatch, restoreFromTrash } = await import("@/lib/crm-store/trash")
    const owner = await ownerOfBatch(body.batchId)
    const noAccess = (await denyUnlessAreaAccess({ ownerId: owner })) ?? (target ? await denyUnlessAreaAccess({ folderId: target }) : null)
    if (noAccess) return noAccess
    const { data: { user } } = await createClient().auth.getUser()
    return NextResponse.json(await restoreFromTrash(body.batchId, user?.id ?? null, target))
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "NEEDS_TARGET") return NextResponse.json({ needsTarget: true, error: e instanceof Error ? e.message : "Choose where to restore it." }, { status: 409 })
    return NextResponse.json({ error: e instanceof Error ? e.message : "It could not be restored." }, { status: 400 })
  }
}
