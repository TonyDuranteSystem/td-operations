/**
 * GET /api/crm-store/browse/shared-with-me — the files the owners shared with THIS staff login from
 * My files › Shared with staff (open / download only). Staff only.
 */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  try {
    const { sharedWithMe } = await import("@/lib/crm-store/staff-share")
    return NextResponse.json({ files: await sharedWithMe(user.id) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the files shared with you." }, { status: 500 })
  }
}
