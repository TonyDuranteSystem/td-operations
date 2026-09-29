/**
 * GET /api/crm-store/browse/owners — every owner in the NEW CRM store (companies, people, companies
 * being formed) with its live file count. Read-only staff browser (Storage page → "New storage").
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  try {
    const { listOwners } = await import("@/lib/crm-store/browse")
    return NextResponse.json({ owners: await listOwners() }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the new storage." }, { status: 500 })
  }
}
