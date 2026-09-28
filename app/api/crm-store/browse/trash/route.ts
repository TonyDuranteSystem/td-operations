/**
 * GET /api/crm-store/browse/trash?owner=<id> — the trash of one storage (each deletion, newest first, with
 * when it is deleted for good). Staff only; a private area only for its owners.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const owner = req.nextUrl.searchParams.get("owner")
  if (!owner) return NextResponse.json({ error: "owner is required" }, { status: 400 })
  const noAccess = await denyUnlessAreaAccess({ ownerId: owner })
  if (noAccess) return noAccess
  try {
    const { trashForOwner } = await import("@/lib/crm-store/trash")
    return NextResponse.json({ batches: await trashForOwner(owner) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the trash." }, { status: 500 })
  }
}
