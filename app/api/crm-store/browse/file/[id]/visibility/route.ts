/**
 * POST /api/crm-store/browse/file/<id>/visibility { visible: boolean } — show / hide a NEW-store file for the
 * client. Updates the store AND the CRM documents row together (the portal still reads the row until
 * Stage 1). A staff-only file (the Formation Summary) is refused.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  if (typeof (body as { visible?: unknown }).visible !== "boolean") {
    return NextResponse.json({ error: "visible must be true or false" }, { status: 400 })
  }
  try {
    const { setClientVisibility } = await import("@/lib/crm-store/browse")
    return NextResponse.json(await setClientVisibility(params.id, (body as { visible: boolean }).visible))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change who can see this file." }, { status: 400 })
  }
}
