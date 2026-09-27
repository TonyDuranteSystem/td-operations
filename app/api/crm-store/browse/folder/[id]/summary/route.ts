/**
 * GET /api/crm-store/browse/folder/<id>/summary — what a move / delete would touch: files and the ones the client can see (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  try {
    const s = await import("@/lib/crm-store/structure")
    return NextResponse.json(await s.folderSummary(params.id), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the folder." }, { status: 400 })
  }
}
