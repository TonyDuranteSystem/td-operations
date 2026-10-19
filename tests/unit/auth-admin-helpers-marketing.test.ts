/** TD Marketing P1: the client-login finders never return a marketing login, so no clean-up, delete, tier-sync, offer or
    password tool can rewrite or remove one by email. */
import { describe, it, expect, vi, beforeEach } from "vitest"

let users: Array<{ id: string; email: string; app_metadata: Record<string, unknown> }> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { auth: { admin: { listUsers: async () => ({ data: { users, nextPage: null }, error: null }) } } },
}))

import { findAuthUserByEmail, findAuthUsersByContactId, findAuthUsersByEmails } from "@/lib/auth-admin-helpers"

beforeEach(() => {
  users = [
    { id: "client-1", email: "rocco@example.test", app_metadata: { role: "client", contact_id: "c1" } },
    { id: "mkt-1", email: "rocco.marketing@example.test", app_metadata: { role: "marketing" } },
    { id: "mkt-2", email: "shared@example.test", app_metadata: { role: "marketing", contact_id: "c9" } },
    { id: "staff-1", email: "luca@example.test", app_metadata: { role: "team" } },
  ]
})

describe("client-login finders skip marketing logins", () => {
  it("by email: a client or staff login is found, a marketing login is not", async () => {
    expect((await findAuthUserByEmail("rocco@example.test"))?.id).toBe("client-1")
    expect((await findAuthUserByEmail("luca@example.test"))?.id).toBe("staff-1")
    expect(await findAuthUserByEmail("rocco.marketing@example.test")).toBeNull()
    expect(await findAuthUserByEmail("  ROCCO.MARKETING@example.test ")).toBeNull()
  })
  it("by contact id: a marketing login is never returned even if it somehow carries a contact id", async () => {
    expect((await findAuthUsersByContactId("c1")).map(u => u.id)).toEqual(["client-1"])
    expect(await findAuthUsersByContactId("c9")).toEqual([])
  })
  it("by a set of emails: only non-marketing logins match", async () => {
    const m = await findAuthUsersByEmails(["rocco@example.test", "rocco.marketing@example.test", "shared@example.test"])
    expect([...m.keys()]).toEqual(["rocco@example.test"])
  })
})
