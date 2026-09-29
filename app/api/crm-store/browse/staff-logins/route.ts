/**
 * GET /api/crm-store/browse/staff-logins — the staff logins the owners can tick to share a file from
 * My files › Shared with staff (owners only; the owners themselves are not listed — they see everything).
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!isOwnerOnly(user)) return NextResponse.json({ error: "Not found." }, { status: 404 })
  try {
    const { listStaffLogins } = await import("@/lib/crm-store/staff-share")
    return NextResponse.json({ logins: await listStaffLogins() }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the staff list." }, { status: 500 })
  }
}
