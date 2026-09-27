import { describe, it, expect, vi, beforeEach } from "vitest"

let insertResult: { error: { message: string } | null } = { error: null }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => ({ insert: () => Promise.resolve(insertResult) }) },
}))
vi.mock("@/lib/portal/web-push", () => ({
  sendPushToContact: vi.fn().mockResolvedValue(undefined),
  sendPushToAccount: vi.fn().mockResolvedValue(undefined),
}))

import { createPortalNotification } from "@/lib/portal/notifications"

describe("createPortalNotification returns its failure (dev job e2fee7e7)", () => {
  beforeEach(() => { insertResult = { error: null } })
  it("ok → error null", async () => {
    expect(await createPortalNotification({ contact_id: "c", type: "t", title: "x" })).toEqual({ error: null })
  })
  it("insert error → returned, not swallowed", async () => {
    insertResult = { error: { message: "boom" } }
    expect(await createPortalNotification({ contact_id: "c", type: "t", title: "x" })).toEqual({ error: "boom" })
  })
  it("no recipient → error", async () => {
    expect((await createPortalNotification({ type: "t", title: "x" })).error).toMatch(/required/)
  })
})
