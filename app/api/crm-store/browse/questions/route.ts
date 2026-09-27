/**
 * GET /api/crm-store/browse/questions — the questions the storage screens ask (Part 16), from the catalog:
 * whether each is asked, its title and the words on each choice. Staff only.
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  try {
    const { listQuestions } = await import("@/lib/crm-store/structure")
    return NextResponse.json({ questions: await listQuestions() }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the questions." }, { status: 500 })
  }
}
