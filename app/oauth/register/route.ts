/**
 * OAuth 2.1 Dynamic Client Registration (RFC 7591)
 * POST /oauth/register
 *
 * Claude.ai calls this to register itself as an OAuth client.
 * Returns client_id and client_secret for subsequent auth flows.
 */

import { NextRequest, NextResponse } from "next/server"
import { registerClient } from "@/lib/oauth"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Validate required fields
    if (!body.redirect_uris || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: "redirect_uris is required" },
        { status: 400 }
      )
    }

    const client = await registerClient({
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types,
      response_types: body.response_types,
      token_endpoint_auth_method: body.token_endpoint_auth_method,
    })

    return NextResponse.json(client, { status: 201 })
  } catch (err) {
    console.error("[OAuth Register]", err)
    return NextResponse.json(
      { error: "server_error", error_description: "Registration failed" },
      { status: 500 }
    )
  }
}
