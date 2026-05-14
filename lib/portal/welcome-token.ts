/**
 * Portal Welcome Tokens — shareable credentials page for first-contact leads.
 *
 * The portal-access email still always sends. This module backs an ADDITIONAL
 * delivery channel: a token-keyed page at `${APP_BASE_URL}/welcome/<token>`
 * that staff can paste into WhatsApp / Telegram / SMS when the client says
 * they did not receive the email.
 *
 * Encryption model:
 *   - The token UUID is the only key material. It is NEVER stored alongside
 *     the ciphertext (the DB only sees the ciphertext). Anyone holding the
 *     token URL can decrypt — anyone with DB read access alone cannot.
 *   - AES-256-GCM (authenticated). Key = SHA-256(token). IV is random per
 *     encryption. Storage format: base64(iv ‖ authTag ‖ ciphertext).
 *
 * Expiry: 7 days. The welcome page renders an expired notice past that.
 */
import crypto from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

// `portal_welcome_tokens` lives in sandbox but is not yet in the
// production-generated `Database` type — npm run gen:types queries the
// production schema and omits the table until the migration ships. Until then
// type the table locally and access it through an untyped-client cast so the
// build stays green. Remove this once the migration is promoted to production
// and `npm run gen:types` adds the table to lib/database.types.ts.
// eslint-disable-next-line no-restricted-syntax -- deferred prod migration: portal_welcome_tokens is sandbox-only until promoted; remove cast when gen:types includes it.
const sb = supabaseAdmin as unknown as SupabaseClient

const ALGO = "aes-256-gcm"
const IV_LEN = 12
const AUTH_TAG_LEN = 16
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export interface CreateWelcomeTokenInput {
  contactId?: string | null
  email: string
  tempPassword: string
  language?: string | null
  source?: string
  sourceId?: string | null
}

export interface CreateWelcomeTokenResult {
  token: string
  welcomeUrl: string
}

export interface WelcomeTokenRow {
  token: string
  contact_id: string | null
  email: string
  encrypted_password: string
  language: string
  source: string
  source_id: string | null
  expires_at: string
  first_viewed_at: string | null
  created_at: string
}

function deriveKey(token: string): Buffer {
  // SHA-256 over the canonical UTF-8 form of the token UUID.
  return crypto.createHash("sha256").update(token, "utf8").digest()
}

export function encryptPassword(token: string, plaintext: string): string {
  const key = deriveKey(token)
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

export function decryptPassword(token: string, encrypted: string): string {
  const buf = Buffer.from(encrypted, "base64")
  if (buf.length < IV_LEN + AUTH_TAG_LEN) {
    throw new Error("Ciphertext too short")
  }
  const iv = buf.subarray(0, IV_LEN)
  const authTag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + AUTH_TAG_LEN)
  const key = deriveKey(token)
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

export async function createWelcomeToken(
  input: CreateWelcomeTokenInput,
): Promise<CreateWelcomeTokenResult> {
  const token = crypto.randomUUID()
  const encrypted_password = encryptPassword(token, input.tempPassword)
  const expires_at = new Date(Date.now() + EXPIRY_MS).toISOString()

  const { error } = await sb.from("portal_welcome_tokens").insert({
    token,
    contact_id: input.contactId ?? null,
    email: input.email,
    encrypted_password,
    language: input.language || "en",
    source: input.source || "offer",
    source_id: input.sourceId ?? null,
    expires_at,
  })

  if (error) {
    throw new Error(`Failed to create welcome token: ${error.message}`)
  }

  return {
    token,
    welcomeUrl: `${APP_BASE_URL}/welcome/${token}`,
  }
}

export async function getWelcomeToken(token: string): Promise<WelcomeTokenRow | null> {
  const { data, error } = await sb
    .from("portal_welcome_tokens")
    .select("token, contact_id, email, encrypted_password, language, source, source_id, expires_at, first_viewed_at, created_at")
    .eq("token", token)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to load welcome token: ${error.message}`)
  }
  return (data as WelcomeTokenRow | null) ?? null
}

export function isWelcomeTokenExpired(row: { expires_at: string }): boolean {
  return new Date(row.expires_at).getTime() < Date.now()
}

export async function markWelcomeTokenViewed(token: string): Promise<void> {
  // Only set first_viewed_at if currently null (first open).
  await sb
    .from("portal_welcome_tokens")
    .update({ first_viewed_at: new Date().toISOString() })
    .eq("token", token)
    .is("first_viewed_at", null)
}

export async function findWelcomeTokenBySource(
  source: string,
  sourceId: string,
): Promise<{ token: string; welcomeUrl: string; expires_at: string } | null> {
  const { data, error } = await sb
    .from("portal_welcome_tokens")
    .select("token, expires_at")
    .eq("source", source)
    .eq("source_id", sourceId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`Failed to look up welcome token: ${error.message}`)
  }
  if (!data) return null
  return {
    token: data.token,
    welcomeUrl: `${APP_BASE_URL}/welcome/${data.token}`,
    expires_at: data.expires_at,
  }
}
