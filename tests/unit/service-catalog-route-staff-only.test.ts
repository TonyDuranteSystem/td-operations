/**
 * N1a P0 — the service-catalog API writes with the service key, and middleware
 * lets any signed-in user reach /api. Create / edit / deactivate must refuse
 * clients and partners (403) and anonymous callers (401) BEFORE touching the DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser } }),
}))

const from = vi.fn()
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (...a: unknown[]) => from(...a) },
}))

import { POST, PUT, DELETE } from "@/app/api/service-catalog/route"

function req(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/service-catalog", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const calls = [
  ["POST", () => POST(req("POST", { name: "Hacked", default_price: 1 }))],
  ["PUT", () => PUT(req("PUT", { id: "x", default_price: 1 }))],
  ["DELETE", () => DELETE(req("DELETE", { id: "x" }))],
] as const

function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ["select", "order", "limit", "insert", "update", "eq"]) c[m] = () => c
  c.single = async () => result
  c.then = (r: (v: unknown) => unknown) => Promise.resolve(result).then(r)
  return c
}

describe("service-catalog writes are staff-only", () => {
  beforeEach(() => {
    getUser.mockReset()
    from.mockReset()
    from.mockImplementation(() => chain({ data: { id: "x", sort_order: 1 }, error: null }))
  })

  for (const [method, call] of calls) {
    it(`${method}: anonymous → 401, no DB write`, async () => {
      getUser.mockResolvedValue({ data: { user: null } })
      const res = await call()
      expect(res.status).toBe(401)
      expect(from).not.toHaveBeenCalled()
    })

    it(`${method}: portal client → 403, no DB write`, async () => {
      getUser.mockResolvedValue({ data: { user: { id: "c", app_metadata: { role: "client" } } } })
      const res = await call()
      expect(res.status).toBe(403)
      expect(from).not.toHaveBeenCalled()
    })

    it(`${method}: partner → 403, no DB write`, async () => {
      getUser.mockResolvedValue({ data: { user: { id: "p", app_metadata: { role: "partner" } } } })
      const res = await call()
      expect(res.status).toBe(403)
      expect(from).not.toHaveBeenCalled()
    })

    it(`${method}: team member → allowed`, async () => {
      getUser.mockResolvedValue({ data: { user: { id: "t", app_metadata: { role: "team" } } } })
      const res = await call()
      expect(res.status).toBe(200)
      expect(from).toHaveBeenCalled()
    })

    it(`${method}: admin → allowed`, async () => {
      getUser.mockResolvedValue({ data: { user: { id: "a", app_metadata: { role: "admin" } } } })
      const res = await call()
      expect(res.status).toBe(200)
    })
  }
})
