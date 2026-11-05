/**
 * TD Social — the Apple alert sender: signing, the request, Apple's answers (server; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * Talks to Apple directly with what Node already has (crypto for the signature, http2 for the connection): no new vendor. Rules that matter:
 *  - The TWO Apple addresses are constants here. Nothing from a database row or from the app is ever used as an address, a path piece or a header
 *    (the phone's token is re-checked as hexadecimal before it goes into the path).
 *  - A phone is removed ONLY when Apple says it is gone (410) or that the token is wrong for this app or system (400 with exactly that reason).
 *    A 403 (wrong key or team), a 429 (too many token updates), any other 400, a timeout or a server error NEVER removes a phone: a bad key must
 *    not be able to empty the phone list.
 *  - The signed token is built once per half-hour slot and kept in this server's memory (Apple wants a token to live up to an hour and dislikes a
 *    new one more often than every 20 minutes). Signatures are randomised, so two servers never produce the same bytes; if Apple ever answers 429
 *    for that, the token would move into a shared row (proved only on a real phone, Step 4).
 *  - Logging: only what the caller passes in (a phone's row id and Apple's short reason). Never the token, the signing token, the key or headers.
 *  - Every connection is closed after use and its error event is handled.
 */
import crypto from "node:crypto"
import http2 from "node:http2"
import type { ApnsKey } from "@/lib/app/apns-key"

export const APNS_HOSTS = { development: "api.sandbox.push.apple.com", production: "api.push.apple.com" } as const
export type ApnsHostEnv = keyof typeof APNS_HOSTS

const TOKEN_RE = /^[0-9a-f]{64,200}$/
const REASON_RE = /^[A-Za-z]{1,40}$/
/** The signed token's life: a new one per slot (30 minutes), so it is never older than 30 minutes and never refreshed more often than that. */
export const TOKEN_SLOT_SECONDS = 1800
/** Apple's limit for the whole payload. */
export const MAX_PAYLOAD_BYTES = 4096
/** An alert nobody saw within this long is dropped by Apple instead of arriving late. */
export const EXPIRY_SECONDS = 3600

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url")

const tokenCache = new Map<string, { slot: number; token: string }>()

/** The signed token Apple wants in the `authorization` header: ES256, key id in the header, team id as issuer, issue time = the start of the slot. */
export function providerToken(key: ApnsKey, nowMs: number, cache: Map<string, { slot: number; token: string }> = tokenCache): string {
  const slot = Math.floor(nowMs / 1000 / TOKEN_SLOT_SECONDS)
  const cacheKey = `${key.keyId}:${key.teamId}`
  const hit = cache.get(cacheKey)
  if (hit && hit.slot === slot) return hit.token
  const head = b64url(JSON.stringify({ alg: "ES256", kid: key.keyId }))
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: slot * TOKEN_SLOT_SECONDS }))
  const input = `${head}.${claims}`
  const sig = crypto.sign("sha256", Buffer.from(input), { key: key.privateKey, dsaEncoding: "ieee-p1363" })
  const token = `${input}.${b64url(sig)}`
  cache.set(cacheKey, { slot, token })
  return token
}

export interface ApnsNotification {
  title: string
  body: string
  /** a same-site relative path the app opens when the alert is tapped */
  url?: string
  /** groups alerts of one chat on the lock screen */
  tag?: string
  /** the icon number; absent = leave the phone's number as it is */
  badge?: number | null
}

export interface ApnsRequest { path: string; headers: Record<string, string>; body: string }

/** A link the app may open: one site-relative path, never an address of another site and never protocol-relative. */
export function safeRelativeUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 500) return null
  return /^\/(?!\/)[^\s\\]*$/.test(url) ? url : null
}

/** What goes to Apple for one phone. Returns null when the token is not a valid hexadecimal alert token (it would otherwise reach the request path). */
export function buildApnsRequest(input: { deviceToken: string; bundleId: string; jwt: string; notification: ApnsNotification; nowMs: number }): ApnsRequest | null {
  if (!TOKEN_RE.test(input.deviceToken)) return null
  const { notification: n } = input
  const aps: Record<string, unknown> = { alert: n.body ? { title: n.title, body: n.body } : { title: n.title }, sound: "default" }
  if (n.tag) aps["thread-id"] = n.tag
  if (typeof n.badge === "number" && Number.isInteger(n.badge) && n.badge >= 0) aps.badge = n.badge
  const payload: Record<string, unknown> = { aps }
  const link = safeRelativeUrl(n.url)
  if (link) payload.url = link
  let body = JSON.stringify(payload)
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    // far over Apple's limit only if the text was not cut upstream: drop the body text rather than fail
    const slim = { aps: { ...aps, alert: { title: n.title.slice(0, 80) } }, ...(link ? { url: link } : {}) }
    body = JSON.stringify(slim)
  }
  const headers: Record<string, string> = {
    authorization: `bearer ${input.jwt}`,
    "apns-topic": input.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(input.nowMs / 1000) + EXPIRY_SECONDS),
    "content-type": "application/json",
  }
  if (n.tag) headers["apns-collapse-id"] = crypto.createHash("sha256").update(n.tag).digest("hex").slice(0, 32)
  return { path: `/3/device/${input.deviceToken}`, headers, body }
}

export interface ApnsAnswer { status: number; reason: string | null }

/** What Apple's answer means for the phone and for the sender. */
export type ApnsOutcome =
  | { kind: "sent" }
  | { kind: "gone"; reason: string }          // remove the phone
  | { kind: "key_problem"; reason: string }   // 403: do NOT remove anything; stop
  | { kind: "slow_down"; reason: string }     // 429: do NOT remove anything; stop
  | { kind: "retry_later"; reason: string }   // server error, timeout, connection problem: keep the phone
  | { kind: "rejected"; reason: string }      // any other refusal: keep the phone

/** The ONLY places a phone is removed: 410, or 400 with one of the two exact reasons. */
export function classifyApnsAnswer(a: ApnsAnswer): ApnsOutcome {
  const reason = a.reason && REASON_RE.test(a.reason) ? a.reason : "unknown"
  if (a.status === 200) return { kind: "sent" }
  if (a.status === 410) return { kind: "gone", reason }
  if (a.status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return { kind: "gone", reason }
  if (a.status === 403) return { kind: "key_problem", reason }
  if (a.status === 429) return { kind: "slow_down", reason }
  if (a.status >= 500) return { kind: "retry_later", reason }
  return { kind: "rejected", reason }
}

export function parseReason(body: string): string | null {
  try {
    const j = JSON.parse(body) as { reason?: unknown }
    return typeof j.reason === "string" && REASON_RE.test(j.reason) ? j.reason : null
  } catch {
    return null
  }
}

/** One open connection to one Apple address. */
export interface ApnsSession {
  send(req: ApnsRequest, timeoutMs: number): Promise<ApnsAnswer>
  close(): void
}
export type ApnsConnect = (host: string) => ApnsSession

/** The real connection (HTTP/2 only, as Apple requires). The host is checked against the two constants; anything else is refused. */
export const connectToApple: ApnsConnect = host => {
  if (host !== APNS_HOSTS.development && host !== APNS_HOSTS.production) throw new Error("not an Apple push host")
  const client = http2.connect(`https://${host}`)
  let broken: Error | null = null
  client.on("error", e => { broken = e })
  client.on("goaway", () => { broken = new Error("connection closed by Apple") })
  return {
    send(req, timeoutMs) {
      return new Promise<ApnsAnswer>((resolve, reject) => {
        if (broken || client.destroyed || client.closed) { reject(broken ?? new Error("connection closed")); return }
        let settled = false
        const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs)
        const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn() }
        try {
          const stream = client.request({ ":method": "POST", ":path": req.path, ...req.headers })
          let status = 0
          let text = ""
          stream.setEncoding("utf8")
          stream.on("response", h => { status = Number(h[":status"]) || 0 })
          stream.on("data", (c: string) => { if (text.length < 2048) text += c })
          stream.on("end", () => finish(() => resolve({ status, reason: parseReason(text) })))
          stream.on("error", e => finish(() => reject(e)))
          stream.on("close", () => finish(() => (status ? resolve({ status, reason: parseReason(text) }) : reject(new Error("stream closed")))))
          stream.end(req.body)
        } catch (e) {
          finish(() => reject(e))
        }
      })
    },
    close() {
      try { client.close() } catch { /* already closed */ }
    },
  }
}
