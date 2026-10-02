/**
 * GET /api/crm-store/mydrive/list?folder=<id|root|shared|drives>&account=<me|address>&page=<token> — what is inside one place of a Google
 * account's Drive (the owner's own by default; any address of the firm's domain). Owners only. Read-only; opening another person's Drive is logged.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { mydriveGate, logDriveUse } from "../_gate"

export async function GET(req: NextRequest) {
  const g = await mydriveGate()
  if (req.nextUrl.searchParams.get("probe") === "1") return NextResponse.json({ allowed: !(g instanceof NextResponse) }, { headers: { "Cache-Control": "no-store" } })
  if (g instanceof NextResponse) return g
  try {
    const { listOwnerDriveFolder, resolveDriveAccount } = await import("@/lib/google-drive")
    const account = resolveDriveAccount(req.nextUrl.searchParams.get("account"))
    const folder = req.nextUrl.searchParams.get("folder") || "root"
    const page = req.nextUrl.searchParams.get("page")
    const r = await listOwnerDriveFolder(folder, page, account)
    if (!page && account !== resolveDriveAccount("me")) await logDriveUse(g, "drive_browse", account, { folder })
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not open your Google Drive." }, { status: 400 })
  }
}
