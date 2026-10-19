/** Council fix (2026-10-18): a staff member could write { role: 'admin' } into their OWN user_metadata and be treated as Antonio for the @claude command. */
import { describe, it, expect, vi } from "vitest"
vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { isAntonioIdentity } from "@/lib/team/claude-trigger"

describe("isAntonioIdentity", () => {
  it("Antonio's email counts", () => expect(isAntonioIdentity({ email: "antonio.durante@tonydurante.us", app_metadata: {} })).toBe(true))
  it("the admin role in app_metadata counts", () => expect(isAntonioIdentity({ email: "jodi@x.us", app_metadata: { role: "admin" } })).toBe(true))
  it("a staff login whose app_metadata role is team does not", () => expect(isAntonioIdentity({ email: "luca@x.us", app_metadata: { role: "team" } })).toBe(false))
  it("a self-written user_metadata admin role is ignored (the object does not even carry the field)", () => {
    const u = { email: "luca@x.us", app_metadata: { role: "team" }, user_metadata: { role: "admin" } }
    expect(isAntonioIdentity(u)).toBe(false)
  })
  it("missing data is not Antonio", () => {
    expect(isAntonioIdentity({})).toBe(false)
    expect(isAntonioIdentity({ email: null, app_metadata: null })).toBe(false)
  })
})
