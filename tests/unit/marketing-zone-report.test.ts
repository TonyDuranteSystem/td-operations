import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { isUsableDeviceZone, zoneToStore } from "@/lib/marketing/zone-report"

// Antonio, 31 Oct 2026: "it must change according to where we connect. If I'm traveling or Rocco is traveling, the time must change accordingly."

describe("zoneToStore: which zone a browser reports is believed", () => {
  it("a real place that differs from the stored zone is stored", () => {
    expect(zoneToStore("Europe/Rome", "Atlantic/Canary")).toBe("Europe/Rome")
    expect(zoneToStore("America/Chicago", "America/New_York")).toBe("America/Chicago")
  })
  it("the same zone changes nothing (no write, no history line)", () => {
    expect(zoneToStore("Atlantic/Canary", "Atlantic/Canary")).toBeNull()
  })
  it("a browser that hides its zone (UTC and its aliases) never overwrites the stored one", () => {
    for (const z of ["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Etc/Unknown"]) expect(zoneToStore(z, "Europe/Rome")).toBeNull()
  })
  it("anything that is not a zone is ignored", () => {
    for (const z of [undefined, null, 42, "", "  ", "Not/AZone", "rome", "../../etc/passwd", "Europe/Rome; drop table"]) expect(zoneToStore(z, "Europe/Rome")).toBeNull()
  })
  it("spaces around a good zone are trimmed", () => { expect(zoneToStore("  Europe/London ", "Europe/Rome")).toBe("Europe/London") })
  it("isUsableDeviceZone agrees", () => { expect(isUsableDeviceZone("Asia/Tokyo")).toBe(true); expect(isUsableDeviceZone("UTC")).toBe(false) })
})

describe("the wiring that protects the people (read from the source, like the frame tests)", () => {
  const route = readFileSync("app/api/marketing/my-zone/route.ts", "utf8")
  const layout = readFileSync("app/marketing/(app)/layout.tsx", "utf8")
  const banner = readFileSync("components/marketing/lead-clocks.tsx", "utf8")
  it("the route changes only the caller's own zone: Antonio's owner clock for the admin, the caller's own row for anyone else", () => {
    expect(route).toMatch(/ctx\.admin === true/)
    expect(route).toMatch(/key: "owner_clock", value: \{ \.\.\.cur, zone: z \}/)
    expect(route).toMatch(/key: "member_time_zones", value: \{ \.\.\.cur, \[ctx\.user\.id\]: z \}/)
    expect(route).not.toMatch(/body\.(userId|memberId|who)/)
  })
  it("the route needs a signed-in marketing context and JSON", () => {
    expect(route).toMatch(/resolveMarketingContext\(\)/)
    expect(route).toMatch(/status: 403/)
    expect(route).toMatch(/content-type/)
  })
  it("the frame mounts the reporter for everybody, and the banner's own clock follows the device only outside a 'View as' preview", () => {
    expect(layout).toMatch(/<ZoneReporter knownZone=\{layoutTime\.selfZone\} \/>/)
    expect(layout).toMatch(/liveYou=\{!ctx\.viewAs\}/)
  })
  it("the banner carries no words, only the times and the places", () => {
    expect(banner).not.toMatch(/Your time|'s time|La tua ora|L'ora di/)
  })
  it("a role preview says which role it is in the sidebar", () => {
    expect(layout).toMatch(/data-testid="view-as-chip"/)
  })
})
