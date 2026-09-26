/** GET /api/crm-store/browse/owner-for-account?account=<id> — the company's owner in the NEW store, or null. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const account = req.nextUrl.searchParams.get("account")
  if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 })
  const { storeOwnerForAccount, storeFilesShownForAccount } = await import("@/lib/crm-store/browse")
  const ownerId = await storeOwnerForAccount(account)
  const shownFileIds = ownerId ? await storeFilesShownForAccount(account, ownerId) : null
  return NextResponse.json({ ownerId, shownFileIds: shownFileIds ?? [] }, { headers: { "Cache-Control": "no-store" } })
}
