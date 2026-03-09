/**
 * OAuth 2.1 Utilities for TD Operations MCP Server
 *
 * Implements OAuth 2.1 with PKCE for Claude.ai custom connector integration.
 * All data stored in Supabase (oauth_clients, oauth_codes, oauth_tokens, oauth_users).
 * Bearer token auth remains active for Claude Code.
 */

import { randomBytes, createHash } from "crypto"
import { supabaseAdmin } from "./supabase-admin"

// ─── Constants ──────────────────────────────────────────

const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 7        // 7 days
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 90       // 90 days
const AUTH_CODE_TTL = 60 * 10                       // 10 minutes

export const OAUTH_ISSUER = process.env.NEXT_PUBLIC_APP_URL || "https://td-operations.vercel.app"

// ─── Token Generation ───────────────────────────────────

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex")
}

export function generateClientId(): string {
  return `td_${randomBytes(16).toString("hex")}`
}

export function generateClientSecret(): string {
  return `tds_${randomBytes(32).toString("hex")}`
}

// ─── PKCE ───────────────────────────────────────────────

export function verifyCodeChallenge(
  verifier: string,
  challenge: string,
  method: string = "S256"
): boolean {
  if (method === "S256") {
    const hash = createHash("sha256").update(verifier).digest("base64url")
    return hash === challenge
  }
  // plain method (not recommended but spec-compliant)
  return verifier === challenge
}

// ─── PIN Hashing (simple, for internal users only) ─────

export function hashPin(pin: string): string {
  return createHash("sha256").update(pin).digest("hex")
}

export function verifyPin(pin: string, hash: string): boolean {
  return hashPin(pin) === hash
}

// ─── Client Registration (DCR) ─────────────────────────

export async function registerClient(params: {
  client_name?: string
  redirect_uris: string[]
  grant_types?: string[]
  response_types?: string[]
  token_endpoint_auth_method?: string
}) {
  const clientId = generateClientId()
  const clientSecret = generateClientSecret()

  const { data, error } = await supabaseAdmin.from("oauth_clients").insert({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: params.client_name || "Unknown Client",
    redirect_uris: params.redirect_uris,
    grant_types: params.grant_types || ["authorization_code"],
    response_types: params.response_types || ["code"],
    token_endpoint_auth_method: params.token_endpoint_auth_method || "client_secret_post",
  }).select().single()

  if (error) throw new Error(`Client registration failed: ${error.message}`)

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: data.client_name,
    redirect_uris: data.redirect_uris,
    grant_types: data.grant_types,
    response_types: data.response_types,
    token_endpoint_auth_method: data.token_endpoint_auth_method,
  }
}

// ─── Authorization Code ─────────────────────────────────

export async function createAuthCode(params: {
  clientId: string
  redirectUri: string
  userId: string
  scope?: string
  codeChallenge?: string
  codeChallengeMethod?: string
}): Promise<string> {
  const code = generateToken(32)
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL * 1000).toISOString()

  const { error } = await supabaseAdmin.from("oauth_codes").insert({
    code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    user_id: params.userId,
    scope: params.scope || "",
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod || "S256",
    expires_at: expiresAt,
  })

  if (error) throw new Error(`Auth code creation failed: ${error.message}`)
  return code
}

export async function exchangeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier?: string
) {
  // Fetch and validate code
  const { data: authCode, error } = await supabaseAdmin
    .from("oauth_codes")
    .select("*")
    .eq("code", code)
    .eq("used", false)
    .single()

  if (error || !authCode) throw new Error("Invalid authorization code")

  // Check expiry
  if (new Date(authCode.expires_at) < new Date()) {
    throw new Error("Authorization code expired")
  }

  // Check client_id and redirect_uri match
  if (authCode.client_id !== clientId) throw new Error("Client ID mismatch")
  if (authCode.redirect_uri !== redirectUri) throw new Error("Redirect URI mismatch")

  // Verify PKCE if code_challenge was set
  if (authCode.code_challenge) {
    if (!codeVerifier) throw new Error("Code verifier required")
    if (!verifyCodeChallenge(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)) {
      throw new Error("Invalid code verifier")
    }
  }

  // Mark code as used
  await supabaseAdmin.from("oauth_codes").update({ used: true }).eq("id", authCode.id)

  // Issue tokens
  return issueTokens(clientId, authCode.user_id, authCode.scope)
}

// ─── Token Issuance ─────────────────────────────────────

export async function issueTokens(clientId: string, userId: string, scope: string = "") {
  const accessToken = generateToken(32)
  const refreshToken = generateToken(48)
  const now = new Date()
  const accessExpires = new Date(now.getTime() + ACCESS_TOKEN_TTL * 1000)
  const refreshExpires = new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000)

  const { error } = await supabaseAdmin.from("oauth_tokens").insert({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: clientId,
    user_id: userId,
    scope,
    access_token_expires_at: accessExpires.toISOString(),
    refresh_token_expires_at: refreshExpires.toISOString(),
  })

  if (error) throw new Error(`Token issuance failed: ${error.message}`)

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  }
}

// ─── Token Refresh ──────────────────────────────────────

export async function refreshAccessToken(refreshToken: string, clientId: string) {
  const { data: token, error } = await supabaseAdmin
    .from("oauth_tokens")
    .select("*")
    .eq("refresh_token", refreshToken)
    .eq("revoked", false)
    .single()

  if (error || !token) throw new Error("Invalid refresh token")
  if (token.client_id !== clientId) throw new Error("Client ID mismatch")
  if (new Date(token.refresh_token_expires_at) < new Date()) {
    throw new Error("Refresh token expired")
  }

  // Revoke old tokens
  await supabaseAdmin.from("oauth_tokens").update({ revoked: true }).eq("id", token.id)

  // Issue new pair
  return issueTokens(clientId, token.user_id, token.scope)
}

// ─── Token Validation ───────────────────────────────────

export async function validateAccessToken(accessToken: string): Promise<{
  valid: boolean
  userId?: string
  clientId?: string
  scope?: string
}> {
  const { data: token, error } = await supabaseAdmin
    .from("oauth_tokens")
    .select("user_id, client_id, scope, access_token_expires_at")
    .eq("access_token", accessToken)
    .eq("revoked", false)
    .single()

  if (error || !token) return { valid: false }
  if (new Date(token.access_token_expires_at) < new Date()) return { valid: false }

  return {
    valid: true,
    userId: token.user_id,
    clientId: token.client_id,
    scope: token.scope,
  }
}

// ─── User Authentication ────────────────────────────────

export async function authenticateUser(email: string, pin: string): Promise<{
  authenticated: boolean
  userId?: string
  name?: string
}> {
  const { data: user, error } = await supabaseAdmin
    .from("oauth_users")
    .select("id, email, pin_hash, name, active")
    .eq("email", email.toLowerCase())
    .eq("active", true)
    .single()

  if (error || !user) return { authenticated: false }
  if (!verifyPin(pin, user.pin_hash)) return { authenticated: false }

  return {
    authenticated: true,
    userId: user.id,
    name: user.name,
  }
}

// ─── Client Validation ──────────────────────────────────

export async function validateClient(clientId: string, clientSecret?: string) {
  const query = supabaseAdmin
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)

  if (clientSecret) {
    query.eq("client_secret", clientSecret)
  }

  const { data, error } = await query.single()
  if (error || !data) return null
  return data
}
