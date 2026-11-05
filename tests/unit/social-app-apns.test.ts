/**
 * TD Social — the Apple alert sender's pure parts (dev job 2072bc3e, Step 2 pull request C2): the key check, the signed token, the request, and what Apple's answers mean.
 */
import { describe, it, expect } from "vitest"
import crypto from "node:crypto"
import { apnsConfigured, normalizePrivateKey, readApnsKey } from "@/lib/app/apns-key"
import { APNS_HOSTS, MAX_PAYLOAD_BYTES, TOKEN_SLOT_SECONDS, buildApnsRequest, classifyApnsAnswer, connectToApple, parseReason, providerToken, safeRelativeUrl } from "@/lib/app/apns"

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const PEM = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim()
const KEY = { keyId: "ABCDE12345", teamId: "TEAM123456", privateKey: PEM }
const TOKEN = "ab".repeat(32)

describe("the key check (first switch of the phone leg)", () => {
  it("no values = not configured, and readApnsKey says no key", () => {
    expect(apnsConfigured({})).toBe(false)
    expect(readApnsKey({})).toBeNull()
  })

  it("all three present = configured; a well-shaped key is read", () => {
    const env = { APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: PEM }
    expect(apnsConfigured(env)).toBe(true)
    expect(readApnsKey(env)).toEqual(KEY)
  })

  it("a Vercel value with the line breaks as the two characters \\n is accepted", () => {
    const escaped = PEM.replace(/\n/g, "\\n")
    expect(normalizePrivateKey(escaped)).toBe(PEM)
    expect(readApnsKey({ APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: escaped })).toEqual(KEY)
  })

  it("garbage is no key: wrong ids, no key text, a public key, an empty value", () => {
    const ok = { APNS_KEY_ID: "ABCDE12345", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: PEM }
    expect(readApnsKey({ ...ok, APNS_KEY_ID: "short" })).toBeNull()
    expect(readApnsKey({ ...ok, APNS_TEAM_ID: "lowercase1" })).toBeNull()
    expect(readApnsKey({ ...ok, APNS_PRIVATE_KEY: "not a key" })).toBeNull()
    expect(readApnsKey({ ...ok, APNS_PRIVATE_KEY: "" })).toBeNull()
    expect(readApnsKey({ ...ok, APNS_PRIVATE_KEY: pair.publicKey.export({ type: "spki", format: "pem" }).toString() })).toBeNull()
  })
})

describe("the signed token", () => {
  const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString())

  it("is ES256 with the key id in the header and the team id as issuer, and the signature verifies", () => {
    const t = providerToken(KEY, 1_800_000_000_000, new Map())
    const [h, c, sig] = t.split(".")
    expect(b64(h)).toEqual({ alg: "ES256", kid: "ABCDE12345" })
    const claims = b64(c)
    expect(claims.iss).toBe("TEAM123456")
    expect(claims.iat).toBe(Math.floor(1_800_000_000 / TOKEN_SLOT_SECONDS) * TOKEN_SLOT_SECONDS)
    expect(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true)
  })

  it("is built once per half-hour slot (same token inside a slot, a new one in the next)", () => {
    const cache = new Map()
    const t0 = 1_800_000_000_000
    const first = providerToken(KEY, t0, cache)
    expect(providerToken(KEY, t0 + 60_000, cache)).toBe(first)
    expect(providerToken(KEY, t0 + (TOKEN_SLOT_SECONDS - 1 - (Math.floor(t0 / 1000) % TOKEN_SLOT_SECONDS)) * 1000, cache)).toBe(first)
    expect(providerToken(KEY, t0 + TOKEN_SLOT_SECONDS * 1000, cache)).not.toBe(first)
  })

  it("a token is never older than half an hour when it is used (the issue time is the slot's start)", () => {
    const now = 1_800_000_000_000
    const iat = b64(providerToken(KEY, now, new Map()).split(".")[1]).iat
    expect(now / 1000 - iat).toBeLessThan(TOKEN_SLOT_SECONDS)
    expect(now / 1000 - iat).toBeGreaterThanOrEqual(0)
  })

  it("a key that cannot sign throws (the caller leaves every phone alone)", () => {
    expect(() => providerToken({ ...KEY, privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }, 1_800_000_000_000, new Map())).toThrow()
  })
})

describe("the request to Apple", () => {
  const base = { deviceToken: TOKEN, bundleId: "com.tonydurante.tdsocial", jwt: "J.W.T", nowMs: 1_800_000_000_000 }

  it("goes to the device path with the topic, push type, priority and an expiry an hour ahead", () => {
    const r = buildApnsRequest({ ...base, notification: { title: "Hi", body: "There", tag: "chat-1", url: "/portal-chats?account=1", badge: 3 } })!
    expect(r.path).toBe(`/3/device/${TOKEN}`)
    expect(r.headers.authorization).toBe("bearer J.W.T")
    expect(r.headers["apns-topic"]).toBe("com.tonydurante.tdsocial")
    expect(r.headers["apns-push-type"]).toBe("alert")
    expect(r.headers["apns-priority"]).toBe("10")
    expect(r.headers["apns-expiration"]).toBe(String(1_800_000_000 + 3600))
    expect(r.headers["apns-collapse-id"]).toBe(crypto.createHash("sha256").update("chat-1").digest("hex").slice(0, 32))
    expect(JSON.parse(r.body)).toEqual({ aps: { alert: { title: "Hi", body: "There" }, sound: "default", "thread-id": "chat-1", badge: 3 }, url: "/portal-chats?account=1" })
  })

  it("an empty body sends the title only; no badge key when the number is unknown (the phone keeps its own)", () => {
    const r = buildApnsRequest({ ...base, notification: { title: "Claude replied", body: "", badge: null } })!
    const j = JSON.parse(r.body)
    expect(j.aps.alert).toEqual({ title: "Claude replied" })
    expect("badge" in j.aps).toBe(false)
    expect("apns-collapse-id" in r.headers).toBe(false)
  })

  it("a badge of 0 IS sent (it clears the number); a negative or fractional one is not", () => {
    expect(JSON.parse(buildApnsRequest({ ...base, notification: { title: "t", body: "", badge: 0 } })!.body).aps.badge).toBe(0)
    expect("badge" in JSON.parse(buildApnsRequest({ ...base, notification: { title: "t", body: "", badge: -1 } })!.body).aps).toBe(false)
    expect("badge" in JSON.parse(buildApnsRequest({ ...base, notification: { title: "t", body: "", badge: 1.5 } })!.body).aps).toBe(false)
  })

  it("a token that is not plain hexadecimal never reaches the request path", () => {
    for (const bad of ["../x", "ab/../cd", "zz".repeat(32), "ab", "AB".repeat(32), `${TOKEN}?x=1`, `${TOKEN}\n`]) {
      expect(buildApnsRequest({ ...base, deviceToken: bad, notification: { title: "t", body: "" } })).toBeNull()
    }
  })

  it("only a same-site relative link is carried", () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/a b", "/a\\b", "", "x"]) expect(safeRelativeUrl(bad)).toBeNull()
    expect(safeRelativeUrl("/team-chat?thread=1")).toBe("/team-chat?thread=1")
    const r = buildApnsRequest({ ...base, notification: { title: "t", body: "", url: "https://evil.example/x" } })!
    expect("url" in JSON.parse(r.body)).toBe(false)
  })

  it("the whole payload stays under Apple's limit: an oversized body is dropped, the title kept", () => {
    const r = buildApnsRequest({ ...base, notification: { title: "T".repeat(300), body: "B".repeat(6000), tag: "t" } })!
    expect(Buffer.byteLength(r.body)).toBeLessThan(MAX_PAYLOAD_BYTES)
    expect(JSON.parse(r.body).aps.alert.body).toBeUndefined()
  })
})

describe("what Apple's answers mean", () => {
  const c = (status: number, reason: string | null) => classifyApnsAnswer({ status, reason }).kind

  it("200 is sent", () => expect(c(200, null)).toBe("sent"))

  it("a phone is removed ONLY on 410, or on 400 with exactly BadDeviceToken / DeviceTokenNotForTopic", () => {
    expect(c(410, "Unregistered")).toBe("gone")
    expect(c(410, null)).toBe("gone")
    expect(c(400, "BadDeviceToken")).toBe("gone")
    expect(c(400, "DeviceTokenNotForTopic")).toBe("gone")
  })

  it("every other answer keeps the phone", () => {
    expect(c(400, "BadTopic")).toBe("rejected")
    expect(c(400, "PayloadTooLarge")).toBe("rejected")
    expect(c(400, "BadCollapseId")).toBe("rejected")
    expect(c(400, null)).toBe("rejected")
    expect(c(413, "PayloadTooLarge")).toBe("rejected")
    expect(c(404, "BadPath")).toBe("rejected")
  })

  it("403 is a key problem and 429 means slow down (neither removes anything)", () => {
    for (const reason of ["InvalidProviderToken", "ExpiredProviderToken", "Forbidden", "BadCertificate", null]) expect(c(403, reason)).toBe("key_problem")
    expect(c(429, "TooManyRequests")).toBe("slow_down")
    expect(c(429, "TooManyProviderTokenUpdates")).toBe("slow_down")
  })

  it("server errors are retry-later and keep the phone", () => {
    for (const s of [500, 502, 503, 504]) expect(c(s, "InternalServerError")).toBe("retry_later")
  })

  it("an odd or hostile reason text is reduced to 'unknown', never trusted or logged as written", () => {
    expect(classifyApnsAnswer({ status: 400, reason: "x\ny; DROP TABLE" })).toEqual({ kind: "rejected", reason: "unknown" })
    expect(classifyApnsAnswer({ status: 410, reason: "a".repeat(200) })).toEqual({ kind: "gone", reason: "unknown" })
  })

  it("parseReason reads Apple's JSON and refuses anything else", () => {
    expect(parseReason('{"reason":"BadDeviceToken"}')).toBe("BadDeviceToken")
    expect(parseReason("not json")).toBeNull()
    expect(parseReason('{"reason":"has space"}')).toBeNull()
    expect(parseReason('{"reason":5}')).toBeNull()
  })
})

describe("the connection", () => {
  it("only the two Apple addresses can be connected to", () => {
    for (const host of ["evil.example", "api.push.apple.com.evil.example", "localhost", "", "api.push.apple.com:8443"]) {
      expect(() => connectToApple(host)).toThrow()
    }
  })

  it("the two addresses are the real Apple ones", () => {
    expect(APNS_HOSTS).toEqual({ development: "api.sandbox.push.apple.com", production: "api.push.apple.com" })
  })
})
