import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { bearerToken, hashToken, parseStageHash, tokenMatches } from "@/lib/storage-app/stage-token"

const token = "a".repeat(64)

describe("stage token (the build machine's door)", () => {
  it("reads a bearer token and nothing else", () => {
    expect(bearerToken(`Bearer ${token}`)).toBe(token)
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken("Bearer short")).toBeNull()
    expect(bearerToken(`Basic ${token}`)).toBeNull()
    expect(bearerToken(`Bearer ${token} extra`)).toBeNull()
  })
  it("matches only the token whose hash is stored", () => {
    const h = hashToken(token)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenMatches(token, h)).toBe(true)
    expect(tokenMatches("b".repeat(64), h)).toBe(false)
    expect(tokenMatches(null, h)).toBe(false)
    expect(tokenMatches(token, null)).toBe(false)
    expect(tokenMatches(token, "not-a-hash")).toBe(false)
    expect(tokenMatches(token, h.toUpperCase())).toBe(false)
  })
  it("a missing or malformed stored hash means the door is closed", () => {
    expect(parseStageHash(null)).toBeNull()
    expect(parseStageHash({})).toBeNull()
    expect(parseStageHash({ sha256: "abc" })).toBeNull()
    expect(parseStageHash({ sha256: hashToken(token) })).toBe(hashToken(token))
  })
  it("the door can only store a paused version — it never offers, and it checks the token first", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "storage-app-release", "stage", "route.ts"), "utf8")
    expect(src.indexOf("requireStageToken")).toBeGreaterThan(-1)
    expect(src.indexOf("requireStageToken")).toBeLessThan(src.indexOf("req.json"))
    expect(src).not.toContain("setOffering")
  })
})
