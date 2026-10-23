/**
 * GET /api/crm-store/browse/file/<id>/share-context — who a chat message about this file may go to, for the staff
 * "eye" pop-up (lib/portal/document-share-message.ts). Staff only, same guards as the visibility route. Read-only.
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ fileId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  try {
    const { getShareContext } = await import("@/lib/portal/document-share-message")
    return NextResponse.json(await getShareContext(params.id))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not work out who the message can go to." }, { status: 400 })
  }
}
