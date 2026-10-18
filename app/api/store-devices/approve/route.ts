/**
 * POST /api/store-devices/approve — the CRM side of the Mac app's sign-in (dev job 1992a087). COOKIE login (not the device token):
 * a staff member who is signed in to the CRM — and has passed the CRM's two-step login, which the gatekeeper enforces on every
 * non-public /api path — approves the device. Body: { device_name, code_challenge, redirect_uri, state }.
 * Answers { redirect } = http://127.0.0.1:<port>/cb?code=…&state=… for the page to open (the app's own loopback listener).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"
import { DeviceAuthError, createAuthCode, logAppEvent } from "@/lib/storage-app/device-auth"
import { isSameOriginJson, needsFreshSecondStep } from "@/lib/storage-app/request-checks"
import { cleanDeviceName, truncateIp } from "@/lib/storage-app/tokens"

export async function POST(req: NextRequest) {
  if (!isSameOriginJson(req.headers, req.nextUrl.host)) return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 })
  // The CRM lets a remembered browser skip the code; approving a Mac asks for the real two-step check this session.
  const hasVerifiedFactor = (user.factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified")
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (needsFreshSecondStep({ hasVerifiedFactor, aal: aalData?.currentLevel })) {
    return NextResponse.json({ error: "Please sign in to the CRM again and enter your two-step code, then approve the Mac." }, { status: 403 })
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const code = await createAuthCode({ userId: user.id, deviceName: b.device_name, codeChallenge: b.code_challenge, redirectUri: b.redirect_uri })
    const state = typeof b.state === "string" && /^[A-Za-z0-9\-_.~]{8,128}$/.test(b.state) ? b.state : ""
    await logAppEvent("app_device_approved", user.id, { deviceName: cleanDeviceName(b.device_name), ip: truncateIp(req.headers.get("x-forwarded-for")) })
    const url = `${b.redirect_uri as string}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`
    return NextResponse.json({ redirect: url }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    if (e instanceof DeviceAuthError) return NextResponse.json({ error: e.message }, { status: e.code === "access_denied" ? 403 : 400 })
    return NextResponse.json({ error: "Could not approve the device. Please try again." }, { status: 500 })
  }
}
