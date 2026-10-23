import { describe, it, expect } from "vitest"
import { generateKeyPairSync, sign } from "crypto"
import { readFileSync } from "fs"
import { join } from "path"
import { buildIsNewer, parseReleasePackage, verifyUpdateSignature, zipPathFor } from "@/lib/storage-app/release-publish"
import { parseRelease } from "@/lib/storage-app/release"

const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")
const file = Buffer.from("pretend this is a zip file ".repeat(100))
const sig = sign(null, file, privateKey).toString("base64")

describe("update signature check (Ed25519, the Sparkle scheme)", () => {
  it("accepts the right signature, rejects a changed file, a wrong key and garbage — never throws", () => {
    expect(verifyUpdateSignature(file, sig, rawPub)).toBe(true)
    expect(verifyUpdateSignature(Buffer.concat([file, Buffer.from("x")]), sig, rawPub)).toBe(false)
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64")
    expect(verifyUpdateSignature(file, sig, other)).toBe(false)
    for (const bad of ["", "not base64!!", "AAAA", sig.slice(0, 20)]) expect(verifyUpdateSignature(file, bad, rawPub)).toBe(false)
    expect(verifyUpdateSignature(file, sig, "short")).toBe(false)
  })
})

describe("release package file", () => {
  const good = { kind: "td-storage-release", version: "0.2.0", build: 2, edSignature: sig, length: file.length, notes: "Fixes", minSystem: "13.0" }
  it("accepts a complete package", () => {
    expect(parseReleasePackage(good)).toMatchObject({ version: "0.2.0", build: 2, length: file.length, minSystem: "13.0" })
  })
  it("rejects anything else: wrong kind, missing fields, bad numbers, non-objects", () => {
    for (const bad of [null, [], "x", {}, { ...good, kind: "other" }, { ...good, version: "latest" }, { ...good, build: 0 }, { ...good, length: 0 }, { ...good, edSignature: "" }]) {
      expect(parseReleasePackage(bad)).toBeNull()
    }
  })
  it("the zip's place is decided from the version only; the build number must go up", () => {
    expect(zipPathFor("0.2.0")).toBe("storage-app/0.2.0/TDStorage-0.2.0.zip")
    const cur = parseRelease({ version: "0.2.0", build: 2, edSignature: "s", length: 5, path: "p/p.zip", enabled: true })
    expect(buildIsNewer(null, 1)).toBe(true)
    expect(buildIsNewer(cur, 2)).toBe(false)
    expect(buildIsNewer(cur, 3)).toBe(true)
  })
})

describe("the publishing doors", () => {
  const root = join(__dirname, "..", "..")
  for (const r of ["prepare", "finish", "offer"]) {
    it(`/app-release/${r} starts with the owner-only guard`, () => {
      expect(readFileSync(join(root, "app", "api", "store-devices", "app-release", r, "route.ts"), "utf8")).toMatch(/requirePublisher\(req\)/)
    })
  }
  it("the guard is same-origin, owner-only and demands a fresh second step", () => {
    const g = readFileSync(join(root, "lib", "storage-app", "publisher-guard.ts"), "utf8")
    expect(g).toContain("isSameOriginJson")
    expect(g).toContain("isOwnerOnly")
    expect(g).toContain("needsFreshSecondStep")
  })
})
