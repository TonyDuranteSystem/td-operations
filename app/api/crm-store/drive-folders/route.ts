/**
 * GET /api/crm-store/drive-folders?folder=<id> — the "Import from Google Drive" picker (owners only): one Drive
 * folder's sub-folders, each with the CRM company it belongs to and its study copy / move. No folder = the top of
 * the Shared Drive (the TEST Drive outside production). ?search=text → matches from the WHOLE Shared Drive
 * (company names + folders at any level). ?probe=1 → { allowed } only.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const { data: { user } } = await createClient().auth.getUser()
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  const { studyCopyAllowed, listDriveFolders, searchDriveFolders } = await import("@/lib/crm-store/drive-import")
  const allowed = !!user && isOwnerOnly(user) && (pilotEnvironmentAllowed() || studyCopyAllowed())
  if (req.nextUrl.searchParams.get("probe") === "1") return NextResponse.json({ allowed }, { headers: { "Cache-Control": "no-store" } })
  if (!allowed) return NextResponse.json({ error: "Owners only, where copying from Google Drive is switched on." }, { status: 403 })
  try {
    const search = req.nextUrl.searchParams.get("search")
    if (search !== null) return NextResponse.json(await searchDriveFolders(search), { headers: { "Cache-Control": "no-store" } })
    return NextResponse.json(await listDriveFolders(req.nextUrl.searchParams.get("folder")), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not open the Drive folder." }, { status: 400 })
  }
}
