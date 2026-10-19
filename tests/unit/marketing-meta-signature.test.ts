import { describe, it, expect } from "vitest"
import crypto from "crypto"
import { checkVerifyHandshake, verifyMetaSignature } from "@/lib/marketing/meta-leads/signature"

const sign = (body: string, secret: string) => "sha256=" + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")

describe("verifyMetaSignature (fails closed)", () => {
  const body = '{"object":"page","entry":[]}'
  it("accepts the exact HMAC of the raw body", () => { expect(verifyMetaSignature(body, sign(body, "s3cret"), "s3cret")).toBe(true) })
  it("accepts an uppercase hex digest", () => {
    const hex = crypto.createHmac("sha256", "s3cret").update(body, "utf8").digest("hex").toUpperCase()
    expect(verifyMetaSignature(body, "sha256=" + hex, "s3cret")).toBe(true)
  })
  it("refuses a different secret", () => { expect(verifyMetaSignature(body, sign(body, "other"), "s3cret")).toBe(false) })
  it("refuses a changed body", () => { expect(verifyMetaSignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false) })
  it("refuses when the secret is missing or empty (never a pass)", () => {
    expect(verifyMetaSignature(body, sign(body, "s3cret"), undefined)).toBe(false)
    expect(verifyMetaSignature(body, sign(body, "s3cret"), "")).toBe(false)
  })
  it("refuses a missing, malformed or truncated header", () => {
    expect(verifyMetaSignature(body, null, "s3cret")).toBe(false)
    expect(verifyMetaSignature(body, "", "s3cret")).toBe(false)
    expect(verifyMetaSignature(body, "sha1=abcd", "s3cret")).toBe(false)
    expect(verifyMetaSignature(body, sign(body, "s3cret").slice(0, -2), "s3cret")).toBe(false)
    expect(verifyMetaSignature(body, "sha256=" + "z".repeat(64), "s3cret")).toBe(false)
  })
})

describe("checkVerifyHandshake", () => {
  it("echoes the challenge only for subscribe + our token", () => {
    expect(checkVerifyHandshake({ mode: "subscribe", token: "tok", challenge: "123" }, "tok")).toEqual({ ok: true, challenge: "123" })
  })
  it("refuses a wrong token, wrong mode, missing challenge", () => {
    expect(checkVerifyHandshake({ mode: "subscribe", token: "nope", challenge: "123" }, "tok").ok).toBe(false)
    expect(checkVerifyHandshake({ mode: "unsubscribe", token: "tok", challenge: "123" }, "tok").ok).toBe(false)
    expect(checkVerifyHandshake({ mode: "subscribe", token: "tok", challenge: "" }, "tok").ok).toBe(false)
  })
  it("refuses everything when no verify token is configured", () => {
    expect(checkVerifyHandshake({ mode: "subscribe", token: "", challenge: "123" }, undefined).ok).toBe(false)
    expect(checkVerifyHandshake({ mode: "subscribe", token: undefined, challenge: "123" }, "").ok).toBe(false)
  })
})
