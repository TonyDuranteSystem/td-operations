import { describe, it, expect, vi, beforeEach } from "vitest"

const getUser = vi.fn()
const importLeads = vi.fn()
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock("@/lib/auth", () => ({ isSecureAdmin: (u: { admin?: boolean }) => u.admin === true }))
vi.mock("@/lib/marketing/meta-leads/service", () => ({ liveImportDeps: async () => ({}) }))
vi.mock("@/lib/marketing/meta-leads/import-history", async (orig) => ({ ...(await orig<typeof import("@/lib/marketing/meta-leads/import-history")>()), importLeadsFromMeta: (...a: unknown[]) => importLeads(...a) }))

import { POST } from "@/app/api/marketing-admin/meta/import-history/route"
import { NextRequest } from "next/server"

const post = (body: unknown) => POST(new NextRequest("http://x/api/marketing-admin/meta/import-history", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))
const today = new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10)

beforeEach(() => { getUser.mockReset(); importLeads.mockReset(); importLeads.mockResolvedValue({ dryRun: true, seen: 0, alreadyHeld: 0, added: 0, days: [], forms: 0, stoppedEarly: false, errors: [] }) })

describe("import-history route", () => {
  it("refuses anyone who is not the strict admin", async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect((await post({ from: daysAgo(3), to: daysAgo(2) })).status).toBe(403)
    getUser.mockResolvedValue({ data: { user: { admin: false } } })
    expect((await post({ from: daysAgo(3), to: daysAgo(2) })).status).toBe(403)
    expect(importLeads).not.toHaveBeenCalled()
  })
  it("refuses bad or out-of-range dates before touching Meta", async () => {
    getUser.mockResolvedValue({ data: { user: { admin: true } } })
    for (const b of [{}, { from: "x", to: "y" }, { from: daysAgo(2), to: daysAgo(5) }, { from: daysAgo(200), to: daysAgo(190) }, { from: daysAgo(60), to: today }]) {
      expect((await post(b)).status, JSON.stringify(b)).toBe(400)
    }
    expect(importLeads).not.toHaveBeenCalled()
  })
  it("only an explicit dryRun:false writes; anything else just counts", async () => {
    getUser.mockResolvedValue({ data: { user: { admin: true } } })
    await post({ from: daysAgo(5), to: daysAgo(4) })
    await post({ from: daysAgo(5), to: daysAgo(4), dryRun: "false" })
    await post({ from: daysAgo(5), to: daysAgo(4), dryRun: false })
    expect(importLeads.mock.calls.map(c => c[2])).toEqual([true, true, false])
  })
})
