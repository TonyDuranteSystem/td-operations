/**
 * OAuth 2.1 Authorization Server Metadata (RFC 8414)
 * GET /.well-known/oauth-authorization-server
 *
 * Claude.ai discovers this endpoint to learn about our OAuth endpoints.
 */

import { NextResponse } from "next/server"

const ISSUER = process.env.NEXT_PUBLIC_APP_URL || "https://td-operations.vercel.app"

export async function GET() {
  return NextResponse.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:tools"],
    service_documentation: `${ISSUER}`,
  }, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    }
  })
}
