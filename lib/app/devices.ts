/**
 * TD Social — the list of registered phones (dev job 2072bc3e, Step 2 pull request A; Council-reviewed plan of 5 Nov 2026).
 *
 * Two halves. The PURE half checks what the phone sent: the alert token must be hexadecimal of a sane length, the bundle id must be the
 * ONE this server accepts, and `apns_env` is a two-value choice, never an address (the server owns the two Apple addresses, so nothing a
 * phone sends can ever become a place the server connects to). The DATABASE half writes with the service key, always scoped to the
 * signed-in person from the session; no route takes a person id from the request.
 *
 * Rules (plan piece 2.2):
 *  - Registering is ONE statement (insert .. on conflict update): a token that moves to another person moves atomically and clears any
 *    revoked mark. No delete-then-insert gap.
 *  - Removing (sign-out) deletes by person AND token AND bundle id, so a late sign-out can never remove the next person's phone.
 *  - A person may hold only a handful of phones; a phone not seen for DEVICE_STALE_DAYS is ignored for that count and, later, by the sender.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { cleanLabel } from "@/lib/app/clean-text"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer table than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export const APNS_ENVS = ["development", "production"] as const
export type ApnsEnv = (typeof APNS_ENVS)[number]

/** A phone not seen for this long stops receiving alerts (used by the sender in pull request C2) and stops counting toward the cap. */
export const DEVICE_STALE_DAYS = 45
/** Most active phones one person may register (an iPhone and an iPad are two; ten is generous and stops unbounded growth). */
export const MAX_ACTIVE_DEVICES_PER_USER = 10

const TOKEN_RE = /^[0-9a-f]{64,200}$/
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/

export interface DeviceRegistration {
  token: string
  bundleId: string
  apnsEnv: ApnsEnv
  deviceName: string
  appVersion: string | null
  appBuild: number | null
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string }

const bad = (code: string, error: string): { ok: false; code: string; error: string } => ({ ok: false, code, error })

function parseToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const t = raw.trim().toLowerCase()
  return TOKEN_RE.test(t) ? t : null
}

/** `allowedBundle` is the one bundle id this server accepts (null = the server cannot tell what it is: nothing is accepted). */
export function parseRegistration(body: unknown, allowedBundle: string | null): ParseResult<DeviceRegistration> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_BODY", "Send a JSON object.")
  const b = body as Record<string, unknown>
  const token = parseToken(b.token)
  if (!token) return bad("BAD_TOKEN", "The alert token is not valid.")
  if (!allowedBundle || b.bundleId !== allowedBundle) return bad("BUNDLE_NOT_ALLOWED", "This app is not allowed on this server.")
  if (typeof b.apnsEnv !== "string" || !(APNS_ENVS as readonly string[]).includes(b.apnsEnv)) return bad("BAD_ENV", "apnsEnv must be development or production.")
  let appVersion: string | null = null
  if (b.appVersion !== undefined && b.appVersion !== null) {
    if (typeof b.appVersion !== "string" || !VERSION_RE.test(b.appVersion)) return bad("BAD_VERSION", "The app version is not valid.")
    appVersion = b.appVersion
  }
  let appBuild: number | null = null
  if (b.appBuild !== undefined && b.appBuild !== null) {
    if (typeof b.appBuild !== "number" || !Number.isInteger(b.appBuild) || b.appBuild < 0 || b.appBuild > 10_000_000) return bad("BAD_BUILD", "The app build is not valid.")
    appBuild = b.appBuild
  }
  const deviceName = cleanLabel(b.deviceName, 60) || "iPhone"
  return { ok: true, value: { token, bundleId: allowedBundle, apnsEnv: b.apnsEnv as ApnsEnv, deviceName, appVersion, appBuild } }
}

export function parseRemoval(body: unknown, allowedBundle: string | null): ParseResult<{ token: string; bundleId: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_BODY", "Send a JSON object.")
  const b = body as Record<string, unknown>
  const token = parseToken(b.token)
  if (!token) return bad("BAD_TOKEN", "The alert token is not valid.")
  if (!allowedBundle || b.bundleId !== allowedBundle) return bad("BUNDLE_NOT_ALLOWED", "This app is not allowed on this server.")
  return { ok: true, value: { token, bundleId: allowedBundle } }
}

export type RegisterOutcome = { ok: true } | { ok: false; code: "TOO_MANY_DEVICES" | "DB_ERROR" }

/** Register (or move, or refresh) a phone for the signed-in person. */
export async function registerDevice(userId: string, reg: DeviceRegistration, now: Date = new Date()): Promise<RegisterOutcome> {
  const since = new Date(now.getTime() - DEVICE_STALE_DAYS * 86_400_000).toISOString()
  const others = await db().from("social_app_devices").select("id", { count: "exact", head: true })
    .eq("user_id", userId).is("revoked_at", null).gte("last_seen_at", since)
    .neq("token", reg.token)
  if (others.error) { console.error("[social-app] device count failed:", others.error.code ?? "unknown"); return { ok: false, code: "DB_ERROR" } }
  if ((others.count ?? 0) >= MAX_ACTIVE_DEVICES_PER_USER) return { ok: false, code: "TOO_MANY_DEVICES" }
  const { error } = await db().from("social_app_devices").upsert({
    user_id: userId,
    token: reg.token,
    bundle_id: reg.bundleId,
    apns_env: reg.apnsEnv,
    device_name: reg.deviceName,
    app_version: reg.appVersion,
    app_build: reg.appBuild,
    last_seen_at: now.toISOString(),
    revoked_at: null,
    revoked_reason: null,
  }, { onConflict: "bundle_id,token" })
  if (error) { console.error("[social-app] device register failed:", error.code ?? "unknown"); return { ok: false, code: "DB_ERROR" } }
  return { ok: true }
}

/** Remove a phone, only if it belongs to this person. Idempotent: removing a phone that is not there removes 0. */
export async function removeDevice(userId: string, token: string, bundleId: string): Promise<{ ok: true; removed: number } | { ok: false; code: "DB_ERROR" }> {
  const { data, error } = await db().from("social_app_devices").delete()
    .eq("user_id", userId).eq("token", token).eq("bundle_id", bundleId).select("id")
  if (error) { console.error("[social-app] device remove failed:", error.code ?? "unknown"); return { ok: false, code: "DB_ERROR" } }
  return { ok: true, removed: Array.isArray(data) ? data.length : 0 }
}
