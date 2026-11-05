/**
 * TD Social — who the server says you are (dev job 2072bc3e, Step 2 pull request A).
 * The Marketing lookups are only made for the logins that may have a Marketing tab, any failure counts as "no", and the self-writable
 * user_metadata is never read for the role.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  user: null as null | Record<string, unknown>,
  admin: { calls: [] as unknown[], result: { ok: false } as unknown, throws: false },
  mkt: { calls: 0, result: { ok: false } as unknown, throws: false },
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock("@/lib/marketing/guard", () => ({
  adminMemberContext: async (u: unknown) => { h.admin.calls.push(u); if (h.admin.throws) throw new Error("db"); return h.admin.result },
  resolveMarketingContext: async () => { h.mkt.calls++; if (h.mkt.throws) throw new Error("db"); return h.mkt.result },
}))

import { resolveAppIdentity } from "@/lib/app/identity"

const withChat = { ok: true, ctx: { permissions: ["leads.read", "chat"] } }
const withoutChat = { ok: true, ctx: { permissions: ["leads.read"] } }
const user = (role: unknown, extra: Record<string, unknown> = {}) => ({ id: "u1", email: "x@example.com", app_metadata: { role }, user_metadata: {}, ...extra })

beforeEach(() => {
  h.user = null
  h.admin = { calls: [], result: { ok: false }, throws: false }
  h.mkt = { calls: 0, result: { ok: false }, throws: false }
})

describe("resolveAppIdentity", () => {
  it("returns null when nobody is signed in", async () => {
    expect(await resolveAppIdentity()).toBeNull()
  })

  it("a staff 'team' login: no Marketing lookup is made at all", async () => {
    h.user = user("team")
    const r = await resolveAppIdentity()
    expect(r?.identity).toEqual({ authRole: "team", isAdmin: false, isStaff: true, marketingChat: false })
    expect(h.admin.calls).toHaveLength(0)
    expect(h.mkt.calls).toBe(0)
  })

  it("an admin is looked up as a Marketing MEMBER (not through the marketing login path)", async () => {
    h.user = user("admin")
    h.admin.result = withChat
    const r = await resolveAppIdentity()
    expect(r?.identity).toEqual({ authRole: "admin", isAdmin: true, isStaff: true, marketingChat: true })
    expect(h.admin.calls).toEqual([{ id: "u1", email: "x@example.com" }])
    expect(h.mkt.calls).toBe(0)
  })

  it("an admin who is a member WITHOUT the chat permission, or is not a member, has no Marketing", async () => {
    h.user = user("admin")
    h.admin.result = withoutChat
    expect((await resolveAppIdentity())?.identity.marketingChat).toBe(false)
    h.admin.result = { ok: false }
    expect((await resolveAppIdentity())?.identity.marketingChat).toBe(false)
  })

  it("a marketing login goes through its own guard only", async () => {
    h.user = user("marketing")
    h.mkt.result = withChat
    const r = await resolveAppIdentity()
    expect(r?.identity).toEqual({ authRole: "marketing", isAdmin: false, isStaff: false, marketingChat: true })
    expect(h.mkt.calls).toBe(1)
    expect(h.admin.calls).toHaveLength(0)
  })

  it("a paused or removed marketing login (the guard says no) has no Marketing", async () => {
    h.user = user("marketing")
    h.mkt.result = { ok: false, status: 403, code: "MEMBER_PAUSED" }
    expect((await resolveAppIdentity())?.identity.marketingChat).toBe(false)
  })

  it("a failed Marketing lookup counts as NO, never as yes", async () => {
    h.user = user("marketing"); h.mkt.throws = true
    expect((await resolveAppIdentity())?.identity.marketingChat).toBe(false)
    h.user = user("admin"); h.admin.throws = true
    expect((await resolveAppIdentity())?.identity.marketingChat).toBe(false)
  })

  it("a client or partner makes no Marketing lookup", async () => {
    for (const role of ["client", "partner", undefined, "wizard"]) {
      h.user = user(role)
      const r = await resolveAppIdentity()
      expect(r?.identity.isStaff).toBe(false)
      expect(r?.identity.marketingChat).toBe(false)
    }
    expect(h.admin.calls).toHaveLength(0)
    expect(h.mkt.calls).toBe(0)
  })

  it("never trusts the self-writable user_metadata for the role", async () => {
    h.user = user("client", { user_metadata: { role: "admin" } })
    const r = await resolveAppIdentity()
    expect(r?.identity).toMatchObject({ authRole: "client", isAdmin: false, isStaff: false })
  })

  it("normalises the role text (spaces and capitals)", async () => {
    h.user = user("  Team ")
    expect((await resolveAppIdentity())?.identity).toMatchObject({ authRole: "team", isStaff: true })
  })

  it("carries the person's id, email and a display name", async () => {
    h.user = user("team", { user_metadata: { full_name: "Luca Rossi" } })
    expect((await resolveAppIdentity())?.user).toEqual({ id: "u1", email: "x@example.com", name: "Luca Rossi" })
  })
})
