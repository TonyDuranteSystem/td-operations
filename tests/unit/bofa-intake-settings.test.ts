import { describe, it, expect } from "vitest"
import { DEFAULT_NOTIFY_TO, NOTIFY_TO_KEY, SUBMIT_TO_KEY, parseAddressSetting, sameAddresses } from "@/lib/bofa-intake/settings"

describe("parseAddressSetting", () => {
  it("reads the stored shape with who/when", () => {
    expect(parseAddressSetting({ emails: ["Sekureye22@Gmail.com"], changed_by: "a@b.co", changed_at: "2026-11-02T00:00:00Z" })).toEqual({
      emails: ["sekureye22@gmail.com"],
      changedBy: "a@b.co",
      changedAt: "2026-11-02T00:00:00Z",
    })
  })

  it("fails closed: missing, empty, malformed or invalid addresses give null (Submit then refuses)", () => {
    for (const bad of [null, undefined, "x", 5, [], {}, { emails: [] }, { emails: "nope" }, { emails: ["not-an-email"] }, { emails: [1, 2] }]) {
      expect(parseAddressSetting(bad)).toBeNull()
    }
  })

  it("keeps at most the allowed number of addresses (too many = rejected, not silently cut)", () => {
    const six = Array.from({ length: 6 }, (_, i) => `u${i}@x.co`)
    expect(parseAddressSetting({ emails: six })).toBeNull()
  })
})

describe("sameAddresses", () => {
  it("ignores order, letter case and duplicates", () => {
    expect(sameAddresses(["a@x.co", "B@x.co"], ["b@x.co", "A@X.CO", "a@x.co"])).toBe(true)
  })
  it("catches any real difference", () => {
    expect(sameAddresses(["a@x.co"], ["a@x.co", "b@x.co"])).toBe(false)
    expect(sameAddresses(["a@x.co"], ["c@x.co"])).toBe(false)
    expect(sameAddresses([], ["a@x.co"])).toBe(false)
  })
})

describe("setting keys", () => {
  it("are the two rows the migration seeds", () => {
    expect(SUBMIT_TO_KEY).toBe("bofa_submit_to")
    expect(NOTIFY_TO_KEY).toBe("bofa_notify_to")
    expect([...DEFAULT_NOTIFY_TO]).toEqual(["support@tonydurante.us"])
  })
})
