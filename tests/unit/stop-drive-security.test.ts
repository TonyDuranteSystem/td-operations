/**
 * Stop Drive, slice S1c round 4 — SECURITY: the staff-only routes this change touched must refuse a signed-in portal CLIENT.
 * `/api/*` inherits only "is logged in" from the middleware, and a client has a login: without its own check a route that writes
 * with the service-role client lets any client file a document into ANY company's storage by naming an account id.
 * The real `requireStaffRoute` runs here (it is not mocked); only the identity is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const state = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  reads: 0,
  saves: 0,
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: new Proxy({}, { get: () => { state.reads++; throw new Error("the route touched the database before checking who is calling") } }),
}))
vi.mock("@/lib/crm-store/save-for-account", () => ({
  CompanyMovingError: class extends Error {},
  saveDocumentForAccount: vi.fn(async () => { state.saves++; return { route: "store", fileId: "f", pointer: "store:f", documentRowId: "d", status: "created" } }),
  saveSignedPdfForAccount: vi.fn(async () => { state.saves++; return { route: "store", fileId: "f", pointer: "store:f", documentRowId: "d", status: "created" } }),
}))

const client = { id: "u-client", email: "client@example.com", app_metadata: { role: "client" }, user_metadata: {} }
const staff = { id: "u-staff", email: "staff@tonydurante.us", app_metadata: { role: "admin" }, user_metadata: {} }

const post = (body: unknown) => new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => { state.user = null; state.reads = 0; state.saves = 0 })

describe("upload-account-document is STAFF ONLY", () => {
  const body = { account_id: "acct-of-someone-else", storage_path: "x/y.pdf", file_name: "y.pdf", mime_type: "application/pdf", category: "Tax" }

  it("a signed-in portal CLIENT gets 403 — nothing is read, nothing is saved", async () => {
    state.user = client
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(post(body))
    expect(res.status).toBe(403)
    expect(state.reads).toBe(0)
    expect(state.saves).toBe(0)
  })

  it("nobody signed in gets 403", async () => {
    state.user = null
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    expect((await POST(post(body))).status).toBe(403)
    expect(state.saves).toBe(0)
  })

  it("a staff member passes the gate (and is then handled by the normal flow)", async () => {
    state.user = staff
    const { POST } = await import("@/app/api/crm/admin-actions/upload-account-document/route")
    const res = await POST(post(body))
    // the database double throws on first read, so the route answers its own error — but it got PAST the gate
    expect(res.status).not.toBe(403)
    expect(state.reads).toBeGreaterThan(0)
  })
})

describe("the other staff routes this change touched refuse a client too", () => {
  it.each([
    ["accounts/[id]/dba/[dbaId]/upload-document", async () => (await import("@/app/api/accounts/[id]/dba/[dbaId]/upload-document/route")).POST(post({ storage_path: "a", file_name: "b" }), { params: { id: "a", dbaId: "d" } })],
    ["flows/[id]/upload-document", async () => (await import("@/app/api/flows/[id]/upload-document/route")).POST(post({ storage_path: "a", file_name: "b" }) as never, { params: { id: "sd" } })],
    ["onboarding-review/[id]/confirm-ra-switch", async () => (await import("@/app/api/onboarding-review/[id]/confirm-ra-switch/route")).POST(post({}) as never, { params: { id: "s" } })],
    ["crm/admin-actions/regen-lease-pdf", async () => (await import("@/app/api/crm/admin-actions/regen-lease-pdf/route")).POST(post({ lease_id: "l" }))],
    ["lease-regen-drive", async () => (await import("@/app/api/lease-regen-drive/route")).POST(post({ lease_id: "l", token: "t" }))],
    ["workflows/upload-task-file", async () => {
      const f = new FormData(); f.set("file", new File(["x"], "x.pdf")); f.set("task_id", "t")
      return (await import("@/app/api/workflows/upload-task-file/route")).POST(new NextRequest("http://localhost/x", { method: "POST", body: f }))
    }],
  ])("%s → a client is refused and nothing is read or saved", async (_name, call) => {
    state.user = client
    const res = await call()
    expect([401, 403]).toContain(res.status)
    expect(state.reads).toBe(0)
    expect(state.saves).toBe(0)
  })
})
