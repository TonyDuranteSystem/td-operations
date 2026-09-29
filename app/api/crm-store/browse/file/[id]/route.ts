/**
 * GET /api/crm-store/browse/file/<id> — the file's CURRENT version, inline, for staff viewing in the
 * read-only new-store browser (trashed files too, so staff can look inside the trash).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  // read-only: a staff member may also open a file the owners shared with them
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id }, { allowSharedRead: true })
  if (noAccess) return noAccess
  try {
    const { readFileForStaff } = await import("@/lib/crm-store/browse")
    const f = await readFileForStaff(params.id)
    const { staffFileHeaders } = await import("@/lib/crm-store/serve")
    return new NextResponse(new Uint8Array(f.bytes), { headers: staffFileHeaders(f.mimeType, f.name) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "File not available." }, { status: 404 })
  }
}
