import { describe, it, expect, vi, beforeEach } from "vitest"
import { accessErrorStatus, accessErrorMessage, TRANSIENT_ACCESS_MESSAGE } from "@/lib/crm-store/access-errors"
import { isGoneError, HttpError } from "@/components/storage/store-ui-rules"

describe("access-check error → HTTP status", () => {
  it("'Not found' answers (gone or private) are 404", () => {
    for (const m of ["Not found.", "Folder not found.", "File not found."]) expect(accessErrorStatus(new Error(m))).toBe(404)
  })
  it("a failed read is a temporary 503 — and the page does NOT treat it as 'gone'", () => {
    const e = new Error(TRANSIENT_ACCESS_MESSAGE)
    expect(accessErrorStatus(e)).toBe(503)
    expect(isGoneError(new HttpError(accessErrorMessage(e), accessErrorStatus(e)))).toBe(false)
  })
  it("an unknown error (network, non-Error) is 503, never 404", () => {
    expect(accessErrorStatus(new Error("fetch failed"))).toBe(503)
    expect(accessErrorStatus("boom")).toBe(503)
    expect(accessErrorStatus(undefined)).toBe(503)
  })
  it("the message stays plain: raw technical text is replaced by the retry sentence on a 503", () => {
    expect(accessErrorMessage(new Error("fetch failed"))).toBe(TRANSIENT_ACCESS_MESSAGE)
    expect(accessErrorMessage(new Error("Folder not found."))).toBe("Folder not found.")
    expect(accessErrorMessage(undefined)).toBe(TRANSIENT_ACCESS_MESSAGE)
  })
  it("a real 404 IS 'gone' for the page", () => {
    expect(isGoneError(new HttpError("Folder not found.", 404))).toBe(true)
  })
})

let role = "partner"
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u", app_metadata: { role } } } }) } }) }))
vi.mock("@/lib/supabase-admin", () => {
  // every query step returns the same chain; awaiting it gives "no duplicate"
  const chain: Record<string, unknown> = { then: (ok: (v: unknown) => void) => ok({ count: 0, data: { id: "f" } }) }
  for (const k of ["select", "eq", "is", "ilike", "maybeSingle"]) chain[k] = () => chain
  return { supabaseAdmin: { from: () => chain } }
})

describe("mint-path: only admin / team", () => {
  beforeEach(() => { role = "partner" })
  it("a partner passes the generic gate but is refused here with a plain message", async () => {
    const { POST } = await import("@/app/api/crm-storage/files/mint-path/route")
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ file_name: "a.pdf" }) }) as never)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/TD team/)
  })
  it("a team member gets a path", async () => {
    role = "team"
    const { POST } = await import("@/app/api/crm-storage/files/mint-path/route")
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ file_name: "a.pdf" }) }) as never)
    expect(res.status).toBe(200)
  })
})
