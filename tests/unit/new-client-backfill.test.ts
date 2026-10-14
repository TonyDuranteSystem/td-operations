import { describe, it, expect, vi, afterEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/google-drive-guard", () => ({ isProductionDatabase: () => false }))

import { planNewClientBackfill, runNewClientBackfill, BackfillRefused } from "@/lib/crm-store/new-client-backfill"

describe("new-client backfill — off by default", () => {
  afterEach(() => { delete process.env.STORE_NEW_CLIENTS })

  it("refuses to plan when the new-clients switch is off", async () => {
    delete process.env.STORE_NEW_CLIENTS
    const p = await planNewClientBackfill("c1")
    expect(p.allowed).toBe(false)
    expect(p.reason).toMatch(/switched off/)
    expect(p.contracts).toEqual([])
  })

  it("runNewClientBackfill throws a plain refusal when the switch is off", async () => {
    await expect(runNewClientBackfill("c1")).rejects.toBeInstanceOf(BackfillRefused)
  })
})
