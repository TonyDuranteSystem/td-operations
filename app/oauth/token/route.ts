/**
 * OAuth 2.1 Token Endpoint
 * POST /oauth/token
 *
 * Handles:
 * - authorization_code → exchange code for access + refresh tokens
 * - refresh_token → get new access token
 *
 * Supports both client_secret_post and client_secret_basic auth.
 */

import { NextRequest, NextResponse } from "next/server"
import { exchangeAuthCode, refreshAccessToken, validateClient } from "@/lib/oauth"

export async function POST(req: NextRequest) {
  try {
    // Parse body (application/x-www-form-urlencoded or JSON)
    let params: Record<string, string> = {}
    const contentType = req.headers.get("content-type") || ""

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData()
      formData.forEach((value, key) => { params[key] = value as string })
    } else {
      params = await req.json()
    }

    // Extract client credentials (from body or Basic auth header)
    let clientId = params.client_id || ""
    let clientSecret = params.client_secret || ""

    const authHeader = req.headers.get("authorization") || ""
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString()
      const [id, secret] = decoded.split(":")
      clientId = clientId || id
      clientSecret = clientSecret || secret
    }

    if (!clientId) {
      return errorResponse("invalid_request", "client_id is required")
    }

    // Validate client
    const client = await validateClient(clientId, clientSecret || undefined)
    if (!client) {
      return errorResponse("invalid_client", "Invalid client credentials", 401)
    }

    const grantType = params.grant_type

    // ─── Authorization Code Grant ─────────────────────────
    if (grantType === "authorization_code") {
      const code = params.code
      const redirectUri = params.redirect_uri
      const codeVerifier = params.code_verifier

      if (!code || !redirectUri) {
        return errorResponse("invalid_request", "code and redirect_uri are required")
      }

      const tokens = await exchangeAuthCode(code, clientId, redirectUri, codeVerifier)
      return NextResponse.json(tokens, {
        headers: {
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
        }
      })
    }

    // ─── Refresh Token Grant ──────────────────────────────
    if (grantType === "refresh_token") {
      const refreshToken = params.refresh_token

      if (!refreshToken) {
        return errorResponse("invalid_request", "refresh_token is required")
      }

      const tokens = await refreshAccessToken(refreshToken, clientId)
      return NextResponse.json(tokens, {
        headers: {
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
        }
      })
    }

    return errorResponse("unsupported_grant_type", `Grant type '${grantType}' is not supported`)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[OAuth Token]", message)

    // Map specific errors to OAuth error codes
    if (message.includes("expired")) {
      return errorResponse("invalid_grant", message)
    }
    if (message.includes("mismatch") || message.includes("Invalid")) {
      return errorResponse("invalid_grant", message)
    }

    return errorResponse("server_error", "Internal server error", 500)
  }
}

function errorResponse(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
      }
    }
  )
}
