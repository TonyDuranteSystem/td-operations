/**
 * GET /api/crm-store/browse/navigation — the storage left side, grouped: Clients (by state, People,
 * Companies being formed, Closed / Cancelled, Missing state, Unfiled), Business, and — only for the
 * owner-only login — My files. Staff only.
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
  try {
    const { navigation } = await import("@/lib/crm-store/structure")
    return NextResponse.json({ groups: await navigation(user ? { id: user.id, email: user.email } : null, isOwnerOnly(user)) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the storage list." }, { status: 500 })
  }
}
