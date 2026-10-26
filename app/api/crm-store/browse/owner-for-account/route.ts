/** GET /api/crm-store/browse/owner-for-account?account=<id> — the company's owner in the NEW store, or null. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const account = req.nextUrl.searchParams.get("account")
  if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 })
  try {
    const { storeOwnerForAccountOrThrow, storeFilesShownForAccount } = await import("@/lib/crm-store/browse")
    // null = this company really has no (live) storage; a database error is a 500 (the screen says "could not check" and offers Retry)
    const ownerId = await storeOwnerForAccountOrThrow(account)
    const shownFileIds = ownerId ? await storeFilesShownForAccount(account, ownerId) : null
    // moved from Drive: the company page then works in the new storage only (Drive stays as the backup)
    const moved = ownerId ? await (await import("@/lib/crm-store/drive-import")).movedAt(account) : null
    return NextResponse.json({ ownerId, shownFileIds: shownFileIds ?? [], moved }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check where this company's files are kept." }, { status: 500 })
  }
}
