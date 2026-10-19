import { describe, it, expect } from "vitest"
import {
  checkCode, hashSecret, newSecret, secretKind, pkceS256, verifyPkce, isValidChallenge, isValidLoopbackRedirect, bearerFrom, truncateIp, cleanDeviceName,
} from "@/lib/storage-app/tokens"

describe("storage-app tokens", () => {
  it("makes distinct 256-bit secrets with a label, and stores only the hash", () => {
    const a = newSecret("access"), b = newSecret("access"), r = newSecret("refresh"), c = newSecret("code")
    expect(a.token).not.toBe(b.token)
    expect(a.token.startsWith("sa_at_")).toBe(true)
    expect(r.token.startsWith("sa_rt_")).toBe(true)
    expect(c.token.startsWith("sa_ac_")).toBe(true)
    expect(a.hash).toBe(hashSecret(a.token))
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.token.length).toBeGreaterThanOrEqual(48)
    expect(secretKind(a.token)).toBe("access")
    expect(secretKind("eyJhbGciOiJIUzI1NiJ9.x.y")).toBeNull()   // a Supabase-style JWT is not one of ours
  })

  it("PKCE S256 matches the RFC 7636 test vector and rejects anything else", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    expect(pkceS256(verifier)).toBe(challenge)
    expect(verifyPkce(verifier, challenge)).toBe(true)
    expect(verifyPkce(verifier + "x", challenge)).toBe(false)
    expect(verifyPkce("short", pkceS256("short"))).toBe(false)           // verifier must be 43–128 chars
    expect(verifyPkce(undefined, challenge)).toBe(false)
    expect(isValidChallenge(challenge)).toBe(true)
    expect(isValidChallenge("nope")).toBe(false)
    expect(isValidChallenge(123)).toBe(false)
  })

  it("accepts only the Mac's own loopback redirect on a high port", () => {
    expect(isValidLoopbackRedirect("http://127.0.0.1:53682/cb")).toBe(true)
    for (const bad of [
      "http://localhost:53682/cb", "https://127.0.0.1:53682/cb", "http://127.0.0.1:80/cb", "http://127.0.0.1:53682/cb?x=1",
      "http://127.0.0.1:53682/cb#f", "http://user@127.0.0.1:53682/cb", "http://127.0.0.1:53682/other", "http://127.0.0.1/cb",
      "http://127.0.0.1:99999/cb", "http://evil.example/cb", "tdstorage://cb", "http://127.0.0.1:53682/cb/..", null, undefined, 5,
    ]) expect(isValidLoopbackRedirect(bad as unknown)).toBe(false)
  })

  it("reads a bearer header strictly", () => {
    expect(bearerFrom("Bearer sa_at_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("sa_at_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(bearerFrom("bearer sa_at_abcdefghijklmnopqrstuvwxyz0123456789")).toBeNull()
    expect(bearerFrom("Bearer short")).toBeNull()
    expect(bearerFrom("Basic abc")).toBeNull()
    expect(bearerFrom(null)).toBeNull()
  })

  it("shortens IP addresses and cleans device names", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0")
    expect(truncateIp("203.0.113.77, 10.0.0.1")).toBe("203.0.113.0")
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3:8d3::")
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp("garbage")).toBeNull()
    expect(cleanDeviceName("  Antonio’s\u0000 MacBook \n Pro ")).toBe("Antonio’s MacBook Pro")
    expect(cleanDeviceName("")).toBeNull()
    expect(cleanDeviceName("x".repeat(81))).toBeNull()
    expect(cleanDeviceName(42)).toBeNull()
  })

  it("the check code is short, readable, stable for one challenge and different for another", () => {
    const a = pkceS256("a".repeat(50)), b = pkceS256("b".repeat(50))
    expect(checkCode(a)).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(checkCode(a)).toBe(checkCode(a))
    // fixed value: the Mac app (Swift) must compute the same code for the same challenge (mac/TDStorage/Tests/.../CoreTests.swift)
    expect(checkCode("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe("VYF9-RWG3")
    expect(checkCode(a)).not.toBe(checkCode(b))
  })
})
