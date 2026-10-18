/**
 * POST /api/store-devices/revoke-all { userId? } — OWNERS ONLY (Antonio): sign out every Mac of the TD Storage app, or every Mac of one
 * person (a leaver). Tokens stop at once; the Mac clears its folder the next time the app runs. Cookie login, same-origin JSON.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { revokeAllDevices } from "@/lib/storage-app/device-auth"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

export async function POST(req: NextRequest) {
  if (!isSameOriginJson(req.headers, req.nextUrl.host)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { userId } = (await req.json().catch(() => ({}))) as { userId?: unknown }
  if (userId !== undefined && (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId))) return NextResponse.json({ error: "Choose a person." }, { status: 400 })
  const n = await revokeAllDevices(user.id, userId as string | undefined)
  return NextResponse.json({ ok: true, signedOut: n })
}
