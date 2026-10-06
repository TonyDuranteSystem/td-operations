/**
 * The window-mode admin switch (dev job f3f3e237, step 4): `floating_windows_enabled`.
 *
 * It turns on a NEW behaviour in the layout every dashboard page shares, so unlike the chat switch it
 * defaults OFF and FAILS CLOSED: only a stored `true` enables it, and a failed settings read means
 * the old behaviour (a full page) everywhere.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const { mockMaybeSingle } = vi.hoisted(() => ({ mockMaybeSingle: vi.fn() }))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  },
}))

import { isFloatingWindowsEnabled } from "@/lib/settings"

// braces matter: returning the mock from beforeEach makes vitest call it as a cleanup function
beforeEach(() => {
  mockMaybeSingle.mockReset()
})

describe("isFloatingWindowsEnabled", () => {
  it("is OFF when nothing has been stored", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    expect(await isFloatingWindowsEnabled()).toBe(false)
  })

  it("is ON only for a stored true", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { value: true }, error: null })
    expect(await isFloatingWindowsEnabled()).toBe(true)
  })

  it("is OFF for false and for anything that is not a real true", async () => {
    for (const v of [false, "true", 1, "1", null, {}, []]) {
      mockMaybeSingle.mockResolvedValue({ data: { value: v }, error: null })
      expect(await isFloatingWindowsEnabled(), `stored ${JSON.stringify(v)}`).toBe(false)
    }
  })

  it("FAILS CLOSED: a settings read error means off", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "db down" } })
    expect(await isFloatingWindowsEnabled()).toBe(false)
  })

  it("FAILS CLOSED: a thrown error means off", async () => {
    mockMaybeSingle.mockImplementation(async () => { throw new Error("network") })
    expect(await isFloatingWindowsEnabled()).toBe(false)
  })
})

describe("the Maintenance switch", () => {
  const panel = readFileSync(join(__dirname, "..", "..", "components/dashboard/maintenance-panel.tsx"), "utf8")

  it("reads and writes the same key, and starts OFF", () => {
    expect(panel).toContain("const WIN_KEY = 'floating_windows_enabled'")
    expect(panel).toContain("const [winOn, setWinOn] = useState(false)")
    expect(panel).toMatch(/setWinOn\(d\.value === true\)/)
    expect(panel).toMatch(/body: JSON\.stringify\(\{ key: WIN_KEY, value: next \}\)/)
  })
})
