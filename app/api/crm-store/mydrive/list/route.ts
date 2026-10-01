/**
 * GET /api/crm-store/mydrive/list?folder=<id|root>&page=<token> — what is inside one folder of the OWNER's own Google Drive
 * (owners only). Read-only; nothing is changed on Drive.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { mydriveGate } from "../_gate"

export async function GET(req: NextRequest) {
  const g = await mydriveGate()
  if (req.nextUrl.searchParams.get("probe") === "1") return NextResponse.json({ allowed: !(g instanceof NextResponse) }, { headers: { "Cache-Control": "no-store" } })
  if (g instanceof NextResponse) return g
  try {
    const { listOwnerDriveFolder } = await import("@/lib/google-drive")
    const r = await listOwnerDriveFolder(req.nextUrl.searchParams.get("folder") || "root", req.nextUrl.searchParams.get("page"))
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not open your Google Drive." }, { status: 400 })
  }
}
