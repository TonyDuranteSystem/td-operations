/**
 * The login loop of the welcome-package job (dev job beb43385, delivery B): a marked link gets no login; the welcome email
 * goes out only while the switch is on and only for a login created right now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ calls: [] as Array<{ method: string; args: unknown[] }>, rows: [] as Array<{ contact_id: string }> }))

vi.mock("@/lib/supabase-admin", () => {
  const builder: Record<string, unknown> = {}
  const chain = (method: string) => (...args: unknown[]) => { h.calls.push({ method, args }); return builder }
  builder.from = chain("from")
  builder.select = chain("select")
  builder.eq = chain("eq")
  builder.is = chain("is")
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.rows, error: null })
  return { supabaseAdmin: builder }
})

import { createLoginsForLinkedMembers, realMemberLoginDeps, type MemberLoginDeps, type MemberLoginResult } from "@/lib/portal/member-logins"

function deps(results: Record<string, MemberLoginResult>, links: string[]) {
  const created: string[] = []
  const sent: Array<{ email: string; fullName: string; tempPassword: string; language: string }> = []
  const d: MemberLoginDeps = {
    listOpenLinks: async () => links,
    createLogin: async ({ contactId }) => { created.push(contactId); return results[contactId] },
    contactInfo: async (id) => ({ fullName: `Name ${id}`, language: id === "it-member" ? "Italian" : "English" }),
    sendWelcome: async (p) => { sent.push(p); return { success: true } },
  }
  return { d, created, sent }
}

const fresh = (email: string): MemberLoginResult => ({ success: true, alreadyExists: false, email, tempPassword: `pw-${email}` })
const existing: MemberLoginResult = { success: true, alreadyExists: true, email: "old@x.com" }

beforeEach(() => { h.calls.length = 0; h.rows = [] })

describe("createLoginsForLinkedMembers", () => {
  it("asks only for links without the no-access mark", async () => {
    h.rows = [{ contact_id: "c1" }, { contact_id: "c2" }]
    const ids = await realMemberLoginDeps().listOpenLinks("acc-1")
    expect(ids).toEqual(["c1", "c2"])
    expect(h.calls).toContainEqual({ method: "is", args: ["access_revoked_at", null] })
    expect(h.calls).toContainEqual({ method: "eq", args: ["account_id", "acc-1"] })
  })

  it("switch off: logins are created as before and nothing is emailed", async () => {
    const { d, created, sent } = deps({ a: fresh("a@x.com"), b: existing }, ["a", "b"])
    const counts = await createLoginsForLinkedMembers({ accountId: "acc", tier: "active", welcomeEmailOn: false }, d)
    expect(created).toEqual(["a", "b"])
    expect(sent).toEqual([])
    expect(counts).toEqual({ created: 1, existing: 1, errors: 0, emailed: 0 })
  })

  it("switch on: a login created now is followed by the welcome email, an existing login is not", async () => {
    const { d, sent } = deps({ a: fresh("a@x.com"), b: existing }, ["a", "b"])
    const counts = await createLoginsForLinkedMembers({ accountId: "acc", tier: "active", welcomeEmailOn: true }, d)
    expect(sent).toEqual([{ email: "a@x.com", fullName: "Name a", tempPassword: "pw-a@x.com", language: "en" }])
    expect(counts).toEqual({ created: 1, existing: 1, errors: 0, emailed: 1 })
  })

  it("switch on: the email goes out in the member's own language", async () => {
    const { d, sent } = deps({ "it-member": fresh("it@x.com") }, ["it-member"])
    await createLoginsForLinkedMembers({ accountId: "acc", tier: "active", welcomeEmailOn: true }, d)
    expect(sent[0].language).toBe("it")
  })

  it("counts a failed login or a thrown error without stopping the others", async () => {
    const { d, created } = deps({ a: { success: false, alreadyExists: false, error: "nope" }, c: fresh("c@x.com") }, ["a", "boom", "c"])
    d.createLogin = async ({ contactId }) => {
      created.push(contactId)
      if (contactId === "boom") throw new Error("kaboom")
      return contactId === "a" ? { success: false, alreadyExists: false, error: "nope" } : fresh("c@x.com")
    }
    const counts = await createLoginsForLinkedMembers({ accountId: "acc", tier: "onboarding", welcomeEmailOn: false }, d)
    expect(created).toEqual(["a", "boom", "c"])
    expect(counts).toEqual({ created: 1, existing: 0, errors: 2, emailed: 0 })
  })

  it("a failed welcome email does not count as sent and does not undo the login", async () => {
    const { d } = deps({ a: fresh("a@x.com") }, ["a"])
    d.sendWelcome = async () => ({ success: false, error: "gmail down" })
    const counts = await createLoginsForLinkedMembers({ accountId: "acc", tier: "active", welcomeEmailOn: true }, d)
    expect(counts).toEqual({ created: 1, existing: 0, errors: 0, emailed: 0 })
  })
})
