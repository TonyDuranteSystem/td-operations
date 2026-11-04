/**
 * GET /api/crm-store/browse/file/<id>/link — a short-lived signed link to the file's CURRENT copy (Antonio 2026-11-04), so the storage
 * screen can PLAY a video / audio file with the browser's own player and DOWNLOAD a big file straight from storage, without the server
 * loading hundreds of MB into memory. Same staff + storage-access checks as the plain file route; nothing is written anywhere.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  // a file shared with the staff member can be opened (read only), like the plain file route
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id }, { allowSharedRead: true })
  if (noAccess) return noAccess
  try {
    const { signedLinkForStaff } = await import("@/lib/crm-store/browse")
    const link = await signedLinkForStaff(params.id)
    return NextResponse.json(link, { headers: { "Cache-Control": "private, no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file is not available." }, { status: 404 })
  }
}
