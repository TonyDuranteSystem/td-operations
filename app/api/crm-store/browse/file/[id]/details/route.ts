/**
 * GET /api/crm-store/browse/file/<id>/details — everything the details panel shows about one file (read-only).
 * Staff only; a private area only for its owners.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  try {
    const { fileDetails } = await import("@/lib/crm-store/extras")
    return NextResponse.json(await fileDetails(params.id), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the file's details." }, { status: 400 })
  }
}
