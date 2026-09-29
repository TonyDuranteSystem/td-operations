/**
 * GET /api/crm-store/browse/folder?owner=<id>[&folder=<id>] — a folder's sub-folders and files in the
 * NEW CRM store (the owner's root when no folder is given). Read-only staff browser.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const owner = req.nextUrl.searchParams.get("owner")
  const folder = req.nextUrl.searchParams.get("folder")
  if (!owner) return NextResponse.json({ error: "owner is required" }, { status: 400 })
  const noAccess = await denyUnlessAreaAccess({ ownerId: owner, folderId: folder })
  if (noAccess) return noAccess
  try {
    const { folderContents } = await import("@/lib/crm-store/browse")
    const throughCompany = req.nextUrl.searchParams.get("via") === "company"
    return NextResponse.json(await folderContents(owner, folder, { throughCompany }), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the folder." }, { status: 500 })
  }
}
