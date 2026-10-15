import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { oneTimeBlocker } from "@/lib/crm-store/one-time"

const ok = { accountType: "One-Time", status: "Active", hasDriveFolder: false, documentCount: 0, hasStorage: false }

describe("oneTimeBlocker", () => {
  it("an Active One-Time company with nothing yet may get a storage", () => {
    expect(oneTimeBlocker(ok)).toBeNull()
  })
  it("refuses everything else", () => {
    expect(oneTimeBlocker({ ...ok, accountType: "Client" })).toMatch(/not a One-Time/)
    expect(oneTimeBlocker({ ...ok, status: "Cancelled" })).toMatch(/not Active/)
    expect(oneTimeBlocker({ ...ok, hasStorage: true })).toMatch(/already/)
    expect(oneTimeBlocker({ ...ok, hasDriveFolder: true })).toMatch(/Drive folder/)
    expect(oneTimeBlocker({ ...ok, documentCount: 2 })).toMatch(/documents/)
  })
})
