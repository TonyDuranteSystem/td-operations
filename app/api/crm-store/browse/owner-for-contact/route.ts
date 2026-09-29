/** GET /api/crm-store/browse/owner-for-contact?contact=<id> — the person's own storage in the NEW store, or null. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const contact = req.nextUrl.searchParams.get("contact")
  if (!contact) return NextResponse.json({ error: "contact is required" }, { status: 400 })
  const { storeOwnerForContact } = await import("@/lib/crm-store/browse")
  return NextResponse.json({ ownerId: await storeOwnerForContact(contact) }, { headers: { "Cache-Control": "no-store" } })
}
