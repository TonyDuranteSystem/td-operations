/**
 * TD Social — the on/off switch fails CLOSED (dev job 2072bc3e, Step 2 pull request A): only a stored `true` turns the server pieces on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ value: undefined as unknown, throws: false, askedKey: "" }))
vi.mock("@/lib/settings", () => ({
  getAppSetting: async (key: string, fallback: unknown) => {
    h.askedKey = key
    if (h.throws) throw new Error("db down")
    return h.value === undefined ? fallback : h.value
  },
}))

import { isSocialAppEnabled, SOCIAL_APP_NOT_ENABLED } from "@/lib/app/enabled"

beforeEach(() => { h.value = undefined; h.throws = false; h.askedKey = "" })

describe("isSocialAppEnabled", () => {
  it("is ON only for a stored boolean true, and reads the right key", async () => {
    h.value = true
    expect(await isSocialAppEnabled()).toBe(true)
    expect(h.askedKey).toBe("social_app_enabled")
  })

  it("is OFF when the setting is missing", async () => {
    expect(await isSocialAppEnabled()).toBe(false)
  })

  it("is OFF for anything that is not exactly true", async () => {
    for (const v of [false, "true", "on", 1, 0, null, {}, [], { enabled: true }]) {
      h.value = v
      expect(await isSocialAppEnabled(), JSON.stringify(v)).toBe(false)
    }
  })

  it("is OFF when the settings read fails (fails closed)", async () => {
    h.throws = true
    expect(await isSocialAppEnabled()).toBe(false)
  })

  it("the refusal answer names the code the app looks for", () => {
    expect(SOCIAL_APP_NOT_ENABLED.code).toBe("APP_NOT_ENABLED")
  })
})
