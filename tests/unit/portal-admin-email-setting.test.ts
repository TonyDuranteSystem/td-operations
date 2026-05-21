/**
 * Tests for isPortalAdminEmailEnabled — the app_settings toggle that gates the
 * admin email sent when a client posts a portal chat message. Defaults ON so
 * behavior is unchanged until ops explicitly turns it off.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { state } = vi.hoisted(() => ({
  state: { data: null as { value: unknown } | null, error: null as unknown },
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: state.data, error: state.error }),
        }),
      }),
    }),
  },
}))

import { isPortalAdminEmailEnabled } from "@/lib/settings"

beforeEach(() => {
  state.data = null
  state.error = null
})

describe("isPortalAdminEmailEnabled", () => {
  it("defaults to true when the setting row is missing", async () => {
    expect(await isPortalAdminEmailEnabled()).toBe(true)
  })

  it("is true when explicitly enabled", async () => {
    state.data = { value: true }
    expect(await isPortalAdminEmailEnabled()).toBe(true)
  })

  it("is false only when explicitly disabled", async () => {
    state.data = { value: false }
    expect(await isPortalAdminEmailEnabled()).toBe(false)
  })

  it("falls back to true when the stored value is null", async () => {
    state.data = { value: null }
    expect(await isPortalAdminEmailEnabled()).toBe(true)
  })
})
