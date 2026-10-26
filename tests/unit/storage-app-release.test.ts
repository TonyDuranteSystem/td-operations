import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildAppcast, isOffered, latestBuildFor, parseAppVersionHeader, parseRelease, rolloutBucket } from "@/lib/storage-app/release"
import { STORAGE_APP_RELEASE_PUBLIC_PATHS } from "@/lib/storage-app/public-paths"
import { parseSettings } from "@/lib/storage-app/settings"

const good = { version: "0.2.0", build: 2, edSignature: "SIG==", length: 1234, path: "storage-app/0.2.0/TDStorage-0.2.0.zip", notes: "Fixes", enabled: true, rolloutPercent: 100, publishedAt: "2026-10-22T12:00:00Z" }

describe("storage app release record", () => {
  it("accepts a complete record and defaults roll-out to 100 and minimum macOS to 13.0", () => {
    const r = parseRelease({ ...good, rolloutPercent: undefined, minSystem: undefined })
    expect(r).toMatchObject({ version: "0.2.0", build: 2, rolloutPercent: 100, minSystem: "13.0", enabled: true })
  })
  it("fails closed: missing pieces, bad version, path tricks, non-record → nothing offered", () => {
    for (const bad of [null, [], "x", {}, { ...good, edSignature: "" }, { ...good, build: 0 }, { ...good, build: 1.5 }, { ...good, length: -1 }, { ...good, version: "latest" }, { ...good, path: "../x.zip" }, { ...good, path: "/abs.zip" }]) {
      expect(parseRelease(bad)).toBeNull()
    }
  })
  it("enabled must be exactly true (anything else = paused)", () => {
    expect(parseRelease({ ...good, enabled: "yes" })?.enabled).toBe(false)
    expect(isOffered(parseRelease({ ...good, enabled: false }), "dev-1")).toBe(false)
  })
})

describe("who is offered the update", () => {
  const at = (pct: number) => parseRelease({ ...good, rolloutPercent: pct })
  it("100% = everybody, 0% = nobody, no record = nobody", () => {
    expect(isOffered(at(100), null)).toBe(true)
    expect(isOffered(at(0), "dev-1")).toBe(false)
    expect(isOffered(null, "dev-1")).toBe(false)
  })
  it("a partial roll-out needs the Mac to name itself, and is stable per Mac and only grows", () => {
    expect(isOffered(at(50), null)).toBe(false)
    const id = "3f2b1c00-aaaa-bbbb-cccc-000000000001"
    const b = rolloutBucket(id)
    expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(100)
    expect(rolloutBucket(id)).toBe(b)
    expect(isOffered(at(b), id)).toBe(false)       // bucket < percent is required
    expect(isOffered(at(b + 1), id)).toBe(true)
    expect(isOffered(at(100), id)).toBe(true)
  })
  it("spreads Macs roughly evenly", () => {
    let n = 0
    for (let i = 0; i < 2000; i++) if (rolloutBucket(`device-${i}`) < 25) n++
    expect(n).toBeGreaterThan(400); expect(n).toBeLessThan(600)
  })
})

describe("the Sparkle feed", () => {
  it("is empty without a release or a link", () => {
    expect(buildAppcast(null, null)).not.toContain("<item>")
    expect(buildAppcast(parseRelease(good), null)).not.toContain("<item>")
  })
  it("carries version, build, signature, length and the link — escaped", () => {
    const xml = buildAppcast(parseRelease({ ...good, notes: "a ]]> b <x>" }), "https://h.example/z.zip?token=a&b=c")
    expect(xml).toContain("<sparkle:version>2</sparkle:version>")
    expect(xml).toContain("<sparkle:shortVersionString>0.2.0</sparkle:shortVersionString>")
    expect(xml).toContain('sparkle:edSignature="SIG=="')
    expect(xml).toContain('length="1234"')
    expect(xml).toContain("token=a&amp;b=c")
    expect(xml).not.toContain("]]> b")
  })
})

describe("update settings and routes", () => {
  it("the check pace is a setting, never below an hour", () => {
    expect(parseSettings({}).updateCheckMinutes).toBe(60)
    expect(parseSettings({ updateCheckMinutes: 5 }).updateCheckMinutes).toBe(60)
    expect(parseSettings({ updateCheckMinutes: 180 }).updateCheckMinutes).toBe(180)
  })
  it("the public feed list matches the route file, and the gatekeeper uses it", () => {
    const root = join(__dirname, "..", "..")
    expect(STORAGE_APP_RELEASE_PUBLIC_PATHS).toEqual(["/api/storage-app-release/appcast.xml"])
    readFileSync(join(root, "app", "api", "storage-app-release", "appcast.xml", "route.ts"), "utf8")
    expect(readFileSync(join(root, "middleware.ts"), "utf8")).toContain("STORAGE_APP_RELEASE_PUBLIC_PATHS.includes(pathname)")
    expect(readFileSync(join(root, "app", "api", "store-devices", "app-download", "route.ts"), "utf8")).toContain("canSeeInstallPage")
  })
})


describe("update hint and app version header", () => {
  const rel = (o: Record<string, unknown> = {}) => parseRelease({ ...good, build: 4, ...o })
  it("a Mac is told the offered build only when it is offered to it", () => {
    expect(latestBuildFor(rel(), "dev-1")).toBe(4)
    expect(latestBuildFor(rel({ enabled: false }), "dev-1")).toBeNull()
    expect(latestBuildFor(null, "dev-1")).toBeNull()
    expect(latestBuildFor(rel({ rolloutPercent: 0 }), "dev-1")).toBeNull()
  })
  it("the hint follows the same roll-out share as the feed (never a hint the feed would not honour)", () => {
    const id = "3f2b1c00-aaaa-bbbb-cccc-000000000001"
    const b = rolloutBucket(id)
    expect(latestBuildFor(rel({ rolloutPercent: b }), id)).toBeNull()
    expect(latestBuildFor(rel({ rolloutPercent: b + 1 }), id)).toBe(4)
  })
  it("reads the version header and refuses anything odd", () => {
    expect(parseAppVersionHeader("0.2.2;4")).toEqual({ version: "0.2.2", build: 4 })
    expect(parseAppVersionHeader(" 1.0;12 ")).toEqual({ version: "1.0", build: 12 })
    for (const bad of [null, undefined, "", "0.2.2", "x;4", "0.2.2;x", "0.2.2;4;5", "<script>;1", "0.2.2;99999999999"]) expect(parseAppVersionHeader(bad as string)).toBeNull()
  })
})
