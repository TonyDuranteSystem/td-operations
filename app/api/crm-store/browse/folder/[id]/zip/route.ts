/**
 * GET /api/crm-store/browse/folder/<id>/zip — the folder and everything in it (all levels) as one zip, for staff.
 * A private area only for its owners. Every download is logged (it can carry personal documents off the CRM).
 * Limits: 2,000 files / 2 GB (the store's zip rules).
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { folderZipListing, streamZip, assertZipFits } = await import("@/lib/crm-store/folders")
    const entries = await folderZipListing(params.id, { staff: user })
    if (!entries.length) return NextResponse.json({ error: "This folder has no files to download." }, { status: 400 })
    assertZipFits(entries)
    const { logZipDownload } = await import("@/lib/crm-store/extras")
    const folderName = await logZipDownload(params.id, entries.length, entries.reduce((n, e) => n + Number(e.size_bytes || 0), 0), user?.id ?? null)
    const name = `${(folderName ?? "folder").replace(/[^A-Za-z0-9 ._-]+/g, "_").trim() || "folder"}.zip`
    return new NextResponse(streamZip(entries), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message.replace(/^store: /, "") : "The zip could not be made." }, { status: 400 })
  }
}
