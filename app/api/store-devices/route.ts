/** GET /api/store-devices — the signed-in staff member's own Mac app devices (the "My devices" list). Cookie login. */
export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { listDevices } from "@/lib/storage-app/device-auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  return NextResponse.json({ devices: await listDevices(user.id) }, { headers: { "Cache-Control": "no-store" } })
}
