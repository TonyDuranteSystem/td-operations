/** GET /api/crm-store/browse/owner-for-contact?contact=<id> — the person's own storage in the NEW store, or null. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const contact = req.nextUrl.searchParams.get("contact")
  if (!contact) return NextResponse.json({ error: "contact is required" }, { status: 400 })
  try {
    const { storeOwnerForContactOrThrow } = await import("@/lib/crm-store/browse")
    return NextResponse.json({ ownerId: await storeOwnerForContactOrThrow(contact) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check where this person's files are kept." }, { status: 500 })
  }
}
