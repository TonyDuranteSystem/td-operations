/**
 * GET /api/crm-store/browse/file/<id>/versions            — every saved copy of the file (newest first)
 * GET /api/crm-store/browse/file/<id>/versions?open=<vid>  — that copy's content (staff viewing, safe headers)
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../../_auth"

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const open = req.nextUrl.searchParams.get("open")
  try {
    if (open) {
      const { readVersionForStaff } = await import("@/lib/crm-store/browse")
      const { staffFileHeaders } = await import("@/lib/crm-store/serve")
      const v = await readVersionForStaff(params.id, open)
      return new NextResponse(new Uint8Array(v.bytes), { headers: staffFileHeaders(v.mimeType, v.name) })
    }
    const { listFileVersions } = await import("@/lib/crm-store/browse")
    return NextResponse.json({ versions: await listFileVersions(params.id) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Versions not available." }, { status: 404 })
  }
}
