/**
 * The build machine's door for a NEW app version (Antonio, 2026-10-27: "when there is a new release automatically will go there" — no picking files).
 * A long random token lives in the owner's 1Password; the CRM keeps only its SHA-256 (app_settings.storage_app_release_stage_hash = { "sha256": "<hex>" }).
 * The token can ONLY put a signed version in the CRM PAUSED. It can never offer a version to the Macs (that stays the owner's button, behind the fresh
 * two-step check) and the server still re-checks the update signature, the size and a higher build number. No hash row = the door does not exist (404).
 */
import { createHash, timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const STAGE_HASH_KEY = "storage_app_release_stage_hash"

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/** PURE: the token from an `Authorization: Bearer …` header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S{32,200})$/.exec(header ?? "")
  return m ? m[1] : null
}

/** PURE: is `token` the one whose SHA-256 is `expectedHex`? Constant time; never throws. */
export function tokenMatches(token: string | null, expectedHex: string | null): boolean {
  if (!token || !expectedHex || !/^[0-9a-f]{64}$/.test(expectedHex)) return false
  const a = Buffer.from(hashToken(token), "hex"), b = Buffer.from(expectedHex, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

/** PURE: the stored hash from the settings value, or null when absent / malformed. */
export function parseStageHash(value: unknown): string | null {
  const h = value && typeof value === "object" ? (value as Record<string, unknown>).sha256 : null
  return typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? h : null
}

export async function loadStageHash(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- app_settings value is jsonb
  const { data } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", STAGE_HASH_KEY).maybeSingle()
  return parseStageHash(data?.value)
}

/** null = allowed. 404 when the door is not set up, 401 for a missing or wrong token (same answer for both, nothing to learn). */
export async function requireStageToken(req: NextRequest): Promise<NextResponse | null> {
  const hash = await loadStageHash()
  if (!hash) return NextResponse.json({ error: "Not found." }, { status: 404 })
  if (!tokenMatches(bearerToken(req.headers.get("authorization")), hash)) return NextResponse.json({ error: "Not allowed." }, { status: 401 })
  return null
}
