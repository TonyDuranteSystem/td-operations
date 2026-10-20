import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const st = vi.hoisted(() => ({
  user: { id: "u1", email: "luca@tonydurante.us", app_metadata: { role: "team" } } as Record<string, unknown> | null,
  signedFor: [] as string[], signFails: false, row: null as null | { id: string; action_type: string; details: Record<string, unknown>; created_at?: string }, eqs: [] as Array<[string, unknown]>, zeroRows: false, deleted: [] as string[], updated: [] as Array<Record<string, unknown>>, dbError: false,
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user } }) } }) }))
vi.mock("@/lib/auth", () => ({ isDashboardUser: (u: unknown) => !!u && (u as { app_metadata?: { role?: string } }).app_metadata?.role !== "client" }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: { from: () => ({ createSignedUploadUrl: async (p: string) => { st.signedFor.push(p); return st.signFails ? { data: null, error: { message: "x" } } : { data: { signedUrl: "https://s", token: "t" }, error: null } } }) },
    from: () => {
      const c: Record<string, unknown> = {}
      let mode = "select"; let patch: Record<string, unknown> = {}
      c.select = () => c; c.maybeSingle = () => c
      c.delete = () => { mode = "delete"; return c }
      c.update = (p: Record<string, unknown>) => { mode = "update"; patch = p; return c }
      c.eq = (col: string, val: unknown) => { st.eqs.push([col, val]); return c }
      c.then = (r: (v: unknown) => unknown) => {
        if (st.dbError) return Promise.resolve({ data: null, error: { message: "db" } }).then(r)
        if (mode === "delete") st.deleted.push("x")
        if (mode === "update") st.updated.push(patch)
        return Promise.resolve({ data: mode === "select" ? st.row : st.zeroRows ? [] : [{ id: "c1" }], error: null }).then(r)
      }
      return c
    },
  },
}))

const post = async (path: string, body: unknown) => {
  const mod = path === "upload" ? await import("@/app/api/tools/fax/upload-url/route") : await import("@/app/api/tools/fax/claim/route")
  const res = await mod.POST(new NextRequest(`http://localhost/api/tools/fax/${path}`, { method: "POST", body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() }
}
beforeEach(() => { st.user = { id: "u1", email: "l@x", app_metadata: { role: "team" } }; st.signedFor.length = 0; st.signFails = false; st.row = null; st.deleted.length = 0; st.updated.length = 0; st.dbError = false; st.eqs.length = 0; st.zeroRows = false })

describe("POST /api/tools/fax/upload-url", () => {
  it("staff only", async () => { st.user = null; expect((await post("upload", { file_name: "a.pdf", file_size: 5 })).status).toBe(403) })
  it("a client login is refused", async () => { st.user = { id: "c", app_metadata: { role: "client" } }; expect((await post("upload", { file_name: "a.pdf", file_size: 5 })).status).toBe(403) })
  it("a file name and a size are needed; more than 10 MB gets a plain sentence and no address", async () => {
    expect((await post("upload", { file_size: 5 })).status).toBe(400)
    const big = await post("upload", { file_name: "a.pdf", file_size: 11 * 1024 * 1024 })
    expect(big.status).toBe(400); expect(big.body.error).toMatch(/too big to fax/); expect(st.signedFor).toEqual([])
  })
  it("a good request gets a signed address and a server-made path (no file-name fragment)", async () => {
    const r = await post("upload", { file_name: "Rossi Passport.secret", file_size: 5 * 1024 * 1024 })
    expect(r.status).toBe(200); expect(r.body.path).toMatch(/^fax-upload\/[0-9a-f-]{36}\.bin$/); expect(r.body.signedUrl).toBe("https://s")
  })
  it("a storage error is a plain 500", async () => { st.signFails = true; expect((await post("upload", { file_name: "a.pdf", file_size: 5 })).status).toBe(500) })
})

describe("POST /api/tools/fax/claim — staff say what happened to an unconfirmed send", () => {
  it("staff only; needs an id and an outcome", async () => {
    st.user = null; expect((await post("claim", { id: "c1", outcome: "sent" })).status).toBe(403)
    st.user = { id: "u1", app_metadata: { role: "team" } }
    expect((await post("claim", { id: "c1" })).status).toBe(400)
    expect((await post("claim", { outcome: "sent" })).status).toBe(400)
    expect((await post("claim", { id: "c1", outcome: "maybe" })).status).toBe(400)
  })
  it("only a still-unresolved claim can be answered (a normal sent fax cannot be deleted this way)", async () => {
    st.row = { id: "c1", action_type: "fax_sent", details: {} }
    const r = await post("claim", { id: "c1", outcome: "not_sent" })
    expect(r.status).toBe(404); expect(st.deleted).toEqual([])
    st.row = null
    expect((await post("claim", { id: "c1", outcome: "not_sent" })).status).toBe(404)
  })
  it("'it did NOT go out' removes the claim; 'it DID go out' turns it into a sent row marked as set by hand", async () => {
    st.row = { id: "c1", action_type: "fax_claim", details: { faxno: "1", content_hash: "h" }, created_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    expect((await post("claim", { id: "c1", outcome: "not_sent" })).body).toMatchObject({ success: true }); expect(st.deleted).toHaveLength(1)
    const r = await post("claim", { id: "c1", outcome: "sent" })
    expect(r.body.success).toBe(true)
    expect(st.updated[0]).toMatchObject({ action_type: "fax_sent" }); expect((st.updated[0].details as Record<string, unknown>).outcome_set_by_hand).toBe("l@x")
  })
  it("the delete / update are tied to the claim kind (a crafted request cannot touch another kind of row)", async () => {
    st.row = { id: "c1", action_type: "fax_claim", details: {}, created_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    await post("claim", { id: "c1", outcome: "not_sent" })
    expect(st.eqs).toContainEqual(["action_type", "fax_claim"])
  })
  it("a send younger than 2 minutes cannot be answered yet (it may still finish)", async () => {
    st.row = { id: "c1", action_type: "fax_claim", details: {}, created_at: new Date(Date.now() - 30_000).toISOString() }
    const r = await post("claim", { id: "c1", outcome: "not_sent" })
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/less than 2 minutes/); expect(st.deleted).toEqual([])
  })
  it("a staff member of the dashboard who is not storage staff is refused", async () => {
    st.user = { id: "u2", app_metadata: { role: "partner" } }
    expect((await post("claim", { id: "c1", outcome: "sent" })).status).toBe(403)
  })
  it("when the delete / update touched NO row (it finished or was answered in the meantime) the answer is 409, never a false 'done'", async () => {
    st.row = { id: "c1", action_type: "fax_claim", details: {}, created_at: new Date(Date.now() - 10 * 60_000).toISOString() }
    st.zeroRows = true
    for (const outcome of ["not_sent", "sent"]) {
      const r = await post("claim", { id: "c1", outcome })
      expect(r.status, outcome).toBe(409); expect(r.body.error, outcome).toMatch(/already answered or finished/)
    }
  })
  it("a database error is a plain 503 (nothing changed)", async () => {
    st.dbError = true
    expect((await post("claim", { id: "c1", outcome: "sent" })).status).toBe(503)
  })
})
