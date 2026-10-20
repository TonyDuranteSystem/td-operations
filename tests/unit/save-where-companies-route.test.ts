import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

const st = vi.hoisted(() => ({ rows: [] as Array<{ id: string; company_name: string; status: string }>, lastLimit: 0 }))
vi.mock("@/app/api/crm-store/browse/_auth", () => ({ denyUnlessStoreStaff: async () => null }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; for (const m of ["select", "ilike", "order"]) c[m] = () => c; c.limit = async (n: number) => { st.lastLimit = n; return { data: st.rows.slice(0, n), error: null } }; return c } },
}))

const get = async (q: string) => { const { GET } = await import("@/app/api/crm-store/save-where/companies/route"); const r = await GET(new NextRequest(`http://localhost/api/crm-store/save-where/companies?q=${encodeURIComponent(q)}`)); return r.json() }

describe("GET /api/crm-store/save-where/companies", () => {
  it("shows at most 15 and says when there are more (so the window can ask to type more)", async () => {
    st.rows = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, company_name: `Acme ${i}`, status: "Active" }))
    const r = await get("Acme")
    expect(r.companies).toHaveLength(15); expect(r.more).toBe(true); expect(st.lastLimit).toBe(16)
  })
  it("no 'more' when everything fits; a short or backslash-only search finds nothing", async () => {
    st.rows = [{ id: "a1", company_name: "Acme", status: "Active" }]
    expect(await get("Acme")).toMatchObject({ more: false, companies: [{ accountId: "a1", name: "Acme" }] })
    expect((await get("a")).companies).toEqual([])
  })
})
