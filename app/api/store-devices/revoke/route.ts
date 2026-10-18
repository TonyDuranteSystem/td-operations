/**
 * POST /api/store-devices/revoke { deviceId } — sign a Mac out. A staff member may revoke their OWN devices; an owner
 * (Antonio) may revoke anyone's (a leaver's Mac). The device's tokens stop working at once; its cache stops being readable
 * at its next check-in (the 24-hour lease). Cookie login.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { revokeDevice } from "@/lib/storage-app/device-auth"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"

export async function POST(req: NextRequest) {
  if (!isSameOriginJson(req.headers, req.nextUrl.host)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  const { deviceId } = (await req.json().catch(() => ({}))) as { deviceId?: unknown }
  if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/i.test(deviceId)) return NextResponse.json({ error: "Choose a device." }, { status: 400 })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage_app_* are not in the generated types until production
  const { data: dev } = await (supabaseAdmin as any).from("storage_app_devices").select("id, user_id").eq("id", deviceId).maybeSingle()
  if (!dev || (dev.user_id !== user.id && !isOwnerOnly(user))) return NextResponse.json({ error: "Device not found." }, { status: 404 })
  await revokeDevice(deviceId, dev.user_id === user.id ? "revoked by the user" : `revoked by owner ${user.email ?? user.id}`, user.id)
  return NextResponse.json({ ok: true })
}
