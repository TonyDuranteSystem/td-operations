/** GET /api/crm-store/browse/types — the store's document types (catalog), for the upload picker. */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { listDocumentTypes } = await import("@/lib/crm-store/browse")
  return NextResponse.json({ types: await listDocumentTypes() })
}
