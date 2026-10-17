/**
 * TD Storage Mac app — device sign-in (dev job 1992a087, phase P0).
 *
 * Flow: the CRM approval page (cookie login + the CRM's two-step login) → createAuthCode → the app swaps the code for tokens
 * (exchangeCode, PKCE) → every request carries the access token (verifyAccessToken) → renewals rotate the refresh token
 * (refreshTokens; a token used twice outside a 10 s grace revokes the whole device).
 *
 * THE USER IS RE-READ FROM THE AUTH SERVER ON EVERY CALL — role, ban and two-step-login state are never kept in the token, so a
 * demoted, suspended or MFA-less person is refused on the very next request. The role test is `isStoreStaffUser`
 * (server-set app_metadata only), never `isAdmin()` (which still trusts the user-editable user_metadata).
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStoreStaffUser } from "@/lib/crm-store/access"
import { resolveMfaGate } from "@/lib/auth/mfa-gate"
import { isOnAllowList, loadAllowList } from "./allow-list"
import {
  ACCESS_TTL_MS, CODE_TTL_MS, DEVICE_MAX_AGE_MS, LEASE_MS, MAX_ACTIVE_DEVICES_PER_USER, REFRESH_GRACE_MS,
  hashSecret, newSecret, verifyPkce, isValidChallenge, isValidLoopbackRedirect, cleanDeviceName, truncateIp,
} from "./tokens"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage_app_* are not in the generated types until production
const db = () => supabaseAdmin as any

/** Every message that says "not allowed" is the same sentence: the reason (not staff / suspended / no two-step login) stays in the audit log. */
const NOT_ALLOWED = "This login cannot use the storage app."

/** Audit (append-only store_events): who approved / signed in / was signed out, and why. Best effort — never blocks the sign-in. */
export async function logAppEvent(event: string, actor: string | null, details: Record<string, unknown>, ids: { ownerId?: string | null; fileId?: string | null; folderId?: string | null } = {}): Promise<boolean> {
  try {
    // supabase-js REPORTS a rejected insert in `error` (it does not throw) — look at it
    const { error } = await db().from("store_events").insert({ event, actor, details, owner_id: ids.ownerId ?? null, file_id: ids.fileId ?? null, folder_id: ids.folderId ?? null })
    if (error) { console.error("[storage-app] audit write failed:", event, error.message); return false }
    return true
  } catch (e) { console.error("[storage-app] audit write failed:", event, e instanceof Error ? e.message : e); return false }
}

export class DeviceAuthError extends Error {
  constructor(public code: "invalid_request" | "invalid_grant" | "access_denied" | "device_revoked", message: string) { super(message) }
}

export interface TokenPair { access_token: string; refresh_token: string; token_type: "Bearer"; expires_in: number; device_id: string }

/** Is this login still allowed to use the app at all? Staff role, not suspended, and the CRM would still let it in (two-step login). */
export function userMayUseApp(user: User | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!user) return { ok: false, reason: "no such user" }
  if (!isStoreStaffUser(user)) return { ok: false, reason: "not staff" }
  const bannedUntil = (user as { banned_until?: string | null }).banned_until
  if (bannedUntil && new Date(bannedUntil).getTime() > Date.now()) return { ok: false, reason: "suspended" }
  const hasVerifiedFactor = (user.factors ?? []).some((f) => f.factor_type === "totp" && f.status === "verified")
  // Would the CRM let this person in? Same decision function as the middleware, asked with "a session that did the check":
  // an enrolled person is always fine here (the check happened at approval); a person with no factor must be exempt / in grace.
  const verdict = resolveMfaGate({
    subject: true,
    exempt: user.app_metadata?.mfa_exempt === true,
    hasVerifiedFactor,
    aal: hasVerifiedFactor ? "aal2" : null,
    rememberedDevice: false,
    graceUntilRaw: process.env.MFA_GRACE_UNTIL,
    now: Date.now(),
  })
  if (verdict !== "allow") return { ok: false, reason: "two-step login not set up" }
  return { ok: true }
}

/** The CRM's rules (`userMayUseApp`) AND the allow-list setting (who Antonio let use the app). */
export async function mayUseAppNow(user: User | null | undefined): Promise<{ ok: true } | { ok: false; reason: string }> {
  const crm = userMayUseApp(user)
  if (!crm.ok) return crm
  if (!isOnAllowList(user?.email, await loadAllowList())) return { ok: false, reason: "not on the allow-list" }
  return { ok: true }
}

async function liveUser(userId: string): Promise<User | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
  if (error || !data?.user) return null
  return data.user
}

/** Step 1 (called by the approval route, after the CRM login + two-step check): make a single-use code. */
export async function createAuthCode(p: { userId: string; deviceName: unknown; codeChallenge: unknown; redirectUri: unknown }): Promise<string> {
  const deviceName = cleanDeviceName(p.deviceName)
  if (!deviceName) throw new DeviceAuthError("invalid_request", "Device name is missing.")
  if (!isValidChallenge(p.codeChallenge)) throw new DeviceAuthError("invalid_request", "Bad code challenge.")
  if (!isValidLoopbackRedirect(p.redirectUri)) throw new DeviceAuthError("invalid_request", "Bad redirect address.")
  const user = await liveUser(p.userId)
  const may = await mayUseAppNow(user)
  if (!may.ok) {
    await logAppEvent("app_signin_refused", p.userId, { step: "approve", reason: may.reason })
    throw new DeviceAuthError("access_denied", NOT_ALLOWED)
  }
  const { count: activeMacs } = await db().from("storage_app_devices").select("id", { count: "exact", head: true }).eq("user_id", p.userId).is("revoked_at", null)
  if ((activeMacs ?? 0) >= MAX_ACTIVE_DEVICES_PER_USER) {
    await logAppEvent("app_signin_refused", p.userId, { step: "approve", reason: "too many Macs" })
    throw new DeviceAuthError("access_denied", `${MAX_ACTIVE_DEVICES_PER_USER} Macs are already signed in for this login. Sign one out on the “Macs signed in” page first.`)
  }
  const { token, hash } = newSecret("code")
  const { error } = await db().from("storage_app_auth_codes").insert({
    code_hash: hash, user_id: p.userId, device_name: deviceName, code_challenge: p.codeChallenge, redirect_uri: p.redirectUri,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) throw new Error(`Could not start the sign-in (${error.message}).`)
  return token
}

async function issuePair(deviceId: string): Promise<TokenPair> {
  const access = newSecret("access")
  const refresh = newSecret("refresh")
  const now = Date.now()
  const { error } = await db().from("storage_app_tokens").insert([
    { device_id: deviceId, kind: "access", token_hash: access.hash, expires_at: new Date(now + ACCESS_TTL_MS).toISOString() },
    { device_id: deviceId, kind: "refresh", token_hash: refresh.hash, expires_at: new Date(now + DEVICE_MAX_AGE_MS).toISOString() },
  ])
  if (error) throw new Error(`Could not issue tokens (${error.message}).`)
  return { access_token: access.token, refresh_token: refresh.token, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), device_id: deviceId }
}

/** Step 2: the app swaps its code (+ PKCE verifier) for tokens. The code is burned first, whatever happens next. */
export async function exchangeCode(p: { code: unknown; codeVerifier: unknown; redirectUri: unknown; ip?: string | null }): Promise<TokenPair> {
  if (typeof p.code !== "string" || !p.code.startsWith("sa_ac_")) throw new DeviceAuthError("invalid_request", "Bad code.")
  const { data: claimed, error } = await db().from("storage_app_auth_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code_hash", hashSecret(p.code)).is("used_at", null).gt("expires_at", new Date().toISOString())
    .select("user_id, device_name, code_challenge, redirect_uri").maybeSingle()
  if (error) throw new Error(`Could not check the code (${error.message}).`)
  if (!claimed) throw new DeviceAuthError("invalid_grant", "This code is not valid any more.")
  if (claimed.redirect_uri !== p.redirectUri) throw new DeviceAuthError("invalid_grant", "Redirect address does not match.")
  if (!verifyPkce(p.codeVerifier, claimed.code_challenge)) throw new DeviceAuthError("invalid_grant", "Verifier does not match.")
  const may = await mayUseAppNow(await liveUser(claimed.user_id))
  if (!may.ok) {
    await logAppEvent("app_signin_refused", claimed.user_id, { step: "exchange", reason: may.reason })
    throw new DeviceAuthError("access_denied", NOT_ALLOWED)
  }
  const { data: device, error: dErr } = await db().from("storage_app_devices")
    .insert({ user_id: claimed.user_id, name: claimed.device_name, last_seen_at: new Date().toISOString(), last_ip_trunc: truncateIp(p.ip) })
    .select("id").single()
  if (dErr || !device) throw new Error(`Could not register the device (${dErr?.message}).`)
  try {
    const pair = await issuePair(device.id)
    await logAppEvent("app_device_signed_in", claimed.user_id, { deviceId: device.id, deviceName: claimed.device_name, ip: truncateIp(p.ip) })
    return pair
  } catch (e) {
    await db().from("storage_app_devices").delete().eq("id", device.id)    // no half-registered device
    throw e
  }
}

export async function revokeDevice(deviceId: string, reason: string, actor: string | null = null): Promise<void> {
  const { data, error } = await db().from("storage_app_devices")
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).eq("id", deviceId).is("revoked_at", null).select("id, user_id, name").maybeSingle()
  if (error) { console.error("[storage-app] could not sign a Mac out:", error.message); throw new Error("Could not sign the Mac out. Please try again.") }
  if (data) await logAppEvent("app_device_revoked", actor ?? data.user_id, { deviceId, deviceName: data.name, ownerOfDevice: data.user_id, reason })
}

/**
 * Renewal. The old refresh token is used up atomically. Used again inside the grace window = the app lost the answer, so a new pair
 * is issued; used again later = someone replayed a stolen token → the WHOLE device is revoked.
 */
export async function refreshTokens(p: { refreshToken: unknown; ip?: string | null }): Promise<TokenPair> {
  if (typeof p.refreshToken !== "string" || !p.refreshToken.startsWith("sa_rt_")) throw new DeviceAuthError("invalid_request", "Bad refresh token.")
  const hash = hashSecret(p.refreshToken)
  const { data: row } = await db().from("storage_app_tokens")
    .select("id, device_id, expires_at, used_at, storage_app_devices!inner(user_id, created_at, revoked_at, last_seen_at)").eq("token_hash", hash).eq("kind", "refresh").maybeSingle()
  if (!row) throw new DeviceAuthError("invalid_grant", "Unknown refresh token.")
  const dev = row.storage_app_devices as { user_id: string; created_at: string; revoked_at: string | null; last_seen_at: string | null }
  if (dev.revoked_at) throw new DeviceAuthError("device_revoked", "This device was signed out.")
  // the 24-hour lease, enforced HERE (the app checks it too): a Mac that has not reached the CRM for a day must be approved again
  if (Date.now() - new Date(dev.last_seen_at ?? dev.created_at).getTime() > LEASE_MS) throw new DeviceAuthError("invalid_grant", "This Mac was away from the CRM for more than 24 hours. Approve it again.")
  if (new Date(row.expires_at).getTime() <= Date.now() || new Date(dev.created_at).getTime() + DEVICE_MAX_AGE_MS <= Date.now()) {
    throw new DeviceAuthError("invalid_grant", "This device must be approved again.")
  }
  const { data: won } = await db().from("storage_app_tokens")
    .update({ used_at: new Date().toISOString() }).eq("id", row.id).is("used_at", null).select("id").maybeSingle()
  if (!won) {
    // somebody (or this app, a moment ago) already used it. Read the time AGAIN: our first read is older than the other call's write,
    // so deciding on it would call a truly simultaneous retry "theft" and sign the Mac out.
    const { data: fresh } = await db().from("storage_app_tokens").select("used_at").eq("id", row.id).maybeSingle()
    const usedAt = fresh?.used_at ? new Date(fresh.used_at).getTime() : 0
    if (!usedAt || Date.now() - usedAt > REFRESH_GRACE_MS) {
      await revokeDevice(row.device_id, "refresh_token_reuse")
      throw new DeviceAuthError("device_revoked", "This device was signed out (token reused).")
    }
  }
  const may = await mayUseAppNow(await liveUser(dev.user_id))
  if (!may.ok) {
    await revokeDevice(row.device_id, `user_not_allowed: ${may.reason}`)
    throw new DeviceAuthError("access_denied", NOT_ALLOWED)
  }
  await db().from("storage_app_devices").update({ last_seen_at: new Date().toISOString(), last_ip_trunc: truncateIp(p.ip) }).eq("id", row.device_id)
  return issuePair(row.device_id)
}

export interface DeviceCaller { user: User; deviceId: string }

/** Every data request: the opaque access token → the real, freshly read user. null = refuse (the caller answers 401). */
export async function verifyAccessToken(token: string, ip?: string | null): Promise<DeviceCaller | null> {
  if (!token.startsWith("sa_at_")) return null
  const { data: row } = await db().from("storage_app_tokens")
    .select("device_id, expires_at, storage_app_devices!inner(user_id, created_at, revoked_at, last_seen_at)").eq("token_hash", hashSecret(token)).eq("kind", "access").maybeSingle()
  if (!row) return null
  const dev = row.storage_app_devices as { user_id: string; created_at: string; revoked_at: string | null; last_seen_at: string | null }
  if (dev.revoked_at) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) return null
  if (new Date(dev.created_at).getTime() + DEVICE_MAX_AGE_MS <= Date.now()) return null
  if (Date.now() - new Date(dev.last_seen_at ?? dev.created_at).getTime() > LEASE_MS) return null     // the 24-hour lease, server side
  const user = await liveUser(dev.user_id)
  if (!user || !(await mayUseAppNow(user)).ok) return null
  // keep "last seen" fresh without a write on every request
  if (!dev.last_seen_at || Date.now() - new Date(dev.last_seen_at).getTime() > 60_000) {
    await db().from("storage_app_devices").update({ last_seen_at: new Date().toISOString(), last_ip_trunc: truncateIp(ip) }).eq("id", row.device_id)
  }
  return { user, deviceId: row.device_id }
}

export async function listDevices(userId: string): Promise<Array<{ id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }>> {
  const { data } = await db().from("storage_app_devices").select("id, name, created_at, last_seen_at, revoked_at").eq("user_id", userId).order("created_at", { ascending: false })
  return data ?? []
}

/** For an OWNER: every Mac that is signed in (or was), with the person's email — the "sign a leaver's Mac out" view. */
export async function listAllDevices(): Promise<Array<{ id: string; user_id: string; email: string | null; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }>> {
  const { data } = await db().from("storage_app_devices").select("id, user_id, name, created_at, last_seen_at, revoked_at").order("created_at", { ascending: false }).limit(500)
  const rows = (data ?? []) as Array<{ id: string; user_id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }>
  const emails = new Map<string, string | null>()
  for (const uid of Array.from(new Set(rows.map((r) => r.user_id)))) emails.set(uid, (await liveUser(uid))?.email ?? null)
  return rows.map((r) => ({ ...r, email: emails.get(r.user_id) ?? null }))
}

/** Sign out every active Mac (optionally only one person's) and burn that person's unused one-time codes. Loops until none are left; returns how many were REALLY signed out. */
export async function revokeAllDevices(by: string, onlyUserId?: string): Promise<number> {
  let done = 0
  for (let round = 0; round < 50; round++) {
    let q = db().from("storage_app_devices").select("id").is("revoked_at", null)
    if (onlyUserId) q = q.eq("user_id", onlyUserId)
    const { data } = await q.limit(200)
    const ids = ((data ?? []) as Array<{ id: string }>).map((d) => d.id)
    if (ids.length === 0) break
    for (const id of ids) { await revokeDevice(id, onlyUserId ? "all of this person's Macs signed out by an owner" : "all Macs signed out by an owner", by); done++ }
  }
  let burn = db().from("storage_app_auth_codes").update({ used_at: new Date().toISOString() }).is("used_at", null)
  if (onlyUserId) burn = burn.eq("user_id", onlyUserId)
  await burn
  return done
}
