/**
 * GET /api/crm-store/browse/file/<id> — the file's CURRENT version, inline, for staff viewing in the
 * read-only new-store browser (trashed files too, so staff can look inside the trash).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  try {
    const { readFileForStaff } = await import("@/lib/crm-store/browse")
    const f = await readFileForStaff(params.id)
    return new NextResponse(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(f.name)}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "File not available." }, { status: 404 })
  }
}
