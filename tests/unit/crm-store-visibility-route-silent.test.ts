import { describe, it, expect, vi, beforeEach } from "vitest"

const setClientVisibility = vi.fn()
vi.mock("@/app/api/crm-store/browse/_auth", () => ({
  denyUnlessStoreStaff: async () => null,
  denyUnlessStorePilotEnv: async () => null,
  denyUnlessAreaAccess: async () => null,
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) } }) }))
vi.mock("@/lib/crm-store/browse", () => ({ setClientVisibility: (...a: unknown[]) => setClientVisibility(...a) }))

import { POST } from "@/app/api/crm-store/browse/file/[id]/visibility/route"
import { NextRequest } from "next/server"

const FILE = "11111111-1111-4111-8111-111111111111"
const call = (body: unknown) => POST(new NextRequest(`http://x/api/crm-store/browse/file/${FILE}/visibility`, { method: "POST", body: JSON.stringify(body) }), { params: { id: FILE } })

beforeEach(() => { setClientVisibility.mockReset(); setClientVisibility.mockResolvedValue({ visible: true, crmRowsUpdated: 1 }) })

describe("show to client — 'Show only' (silent) reaches the store layer", () => {
  it("silent:true is passed on, and only when it is exactly true", async () => {
    await call({ visible: true, suppressChat: true, silent: true })
    expect(setClientVisibility).toHaveBeenLastCalledWith(FILE, true, "staff-1", { refusePersonal: false, suppressChat: true, silent: true })
    await call({ visible: true, suppressChat: true, silent: "yes" })
    expect(setClientVisibility.mock.calls.at(-1)?.[3].silent).toBe(false)
    await call({ visible: true })
    expect(setClientVisibility.mock.calls.at(-1)?.[3].silent).toBe(false)
  })
  it("a plain show is NOT silent (the client is still alerted as before)", async () => {
    await call({ visible: true, suppressChat: true })
    expect(setClientVisibility.mock.calls.at(-1)?.[3]).toEqual({ refusePersonal: false, suppressChat: true, silent: false })
  })
  it("visible must still be a boolean", async () => {
    const r = await call({ silent: true })
    expect(r.status).toBe(400)
    expect(setClientVisibility).not.toHaveBeenCalled()
  })
})
