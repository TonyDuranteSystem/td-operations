/**
 * GET /api/crm-store/browse/filter?owner=<id>&kind=all|shown|review|untyped — one storage's files matching a filter,
 * across all its folders. Staff only; a private area only for its owners.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../_auth"
import { FILTER_KINDS, type FilterKind } from "@/lib/crm-store/extras"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const owner = req.nextUrl.searchParams.get("owner")
  const kind = req.nextUrl.searchParams.get("kind")
  if (!owner || !kind || !(FILTER_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: "owner and kind are required" }, { status: 400 })
  const noAccess = await denyUnlessAreaAccess({ ownerId: owner })
  if (noAccess) return noAccess
  try {
    const { filterFiles } = await import("@/lib/crm-store/extras")
    return NextResponse.json({ files: await filterFiles(owner, kind as FilterKind) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not filter the files." }, { status: 500 })
  }
}
