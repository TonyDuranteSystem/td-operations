/**
 * POST /api/storage-app/token — the Mac app swaps its one-time code (PKCE) for tokens, or renews with its refresh token.
 * PUBLIC in the gatekeeper by exact path (the app has no browser cookie); it authenticates by the code/refresh token itself.
 * Body (JSON): { grant_type: "authorization_code", code, code_verifier, redirect_uri } | { grant_type: "refresh_token", refresh_token }
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { DeviceAuthError, exchangeCode, refreshTokens } from "@/lib/storage-app/device-auth"

const H = { "Cache-Control": "no-store", Pragma: "no-cache" }

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const ip = req.headers.get("x-forwarded-for")
  try {
    if (body.grant_type === "authorization_code") {
      return NextResponse.json(await exchangeCode({ code: body.code, codeVerifier: body.code_verifier, redirectUri: body.redirect_uri, ip }), { headers: H })
    }
    if (body.grant_type === "refresh_token") {
      return NextResponse.json(await refreshTokens({ refreshToken: body.refresh_token, ip }), { headers: H })
    }
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400, headers: H })
  } catch (e) {
    if (e instanceof DeviceAuthError) {
      return NextResponse.json({ error: e.code, error_description: e.message }, { status: e.code === "access_denied" || e.code === "device_revoked" ? 403 : 400, headers: H })
    }
    return NextResponse.json({ error: "server_error", error_description: "Could not complete the sign-in. Please try again." }, { status: 500, headers: H })
  }
}
