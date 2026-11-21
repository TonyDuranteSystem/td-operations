/**
 * What the form's "portal access" tick does to a member's link to the company (dev job beb43385, delivery B).
 * Unticked → the no-access mark; ticked → lifts only a mark the form itself put there; no answer → nothing.
 */
import { describe, expect, it } from "vitest"
import { applyFormPortalAccess, decideFormAccess, type LinkDb } from "@/lib/members/apply-form-portal-access"

type Call = { table: string; values: Record<string, unknown>; filters: Array<[string, ...unknown[]]> }

function fakeDb(error: string | null = null, count?: number) {
  const calls: Call[] = []
  const db: LinkDb = {
    from: (table) => ({
      update: (values) => {
        const call: Call = { table, values, filters: [] }
        calls.push(call)
        const q: Record<string, unknown> = {}
        q.eq = (c: string, v: string) => { call.filters.push(["eq", c, v]); return q }
        q.is = (c: string, v: null) => { call.filters.push(["is", c, v]); return q }
        q.not = (c: string, op: string, v: null) => { call.filters.push(["not", c, op, v]); return q }
        q.then = (resolve: (v: unknown) => unknown) => resolve({ error: error ? { message: error } : null, ...(count === undefined ? {} : { count }) })
        return q as never
      },
    }),
  }
  return { db, calls }
}

const base = { accountId: "acc-1", contactId: "member-1", ownerContactId: "owner-1", now: "2026-11-19T12:00:00.000Z" }

describe("decideFormAccess", () => {
  it("maps the answer to an action", () => {
    expect(decideFormAccess(false)).toBe("mark")
    expect(decideFormAccess(true)).toBe("lift")
    expect(decideFormAccess(null)).toBe("none")
    expect(decideFormAccess(undefined)).toBe("none")
  })
})

describe("applyFormPortalAccess", () => {
  it("unticked puts the mark on this company's link only, keeping an earlier mark's time", async () => {
    const { db, calls } = fakeDb()
    const r = await applyFormPortalAccess({ ...base, ticked: false, db })
    expect(r).toEqual({ action: "mark" })
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe("account_contacts")
    expect(calls[0].values).toEqual({ access_revoked_at: base.now })
    // access_revoked_by must be empty too: a link the team has decided on (taken away, or given back) is never marked by the form.
    expect(calls[0].filters).toEqual([["eq", "account_id", "acc-1"], ["eq", "contact_id", "member-1"], ["is", "access_revoked_at", null], ["is", "access_revoked_by", null]])
  })

  it("never marks the person chosen as the SS-4 Responsible Party (they sign it in the portal) — QA 21 Nov 2026", async () => {
    const { db, calls } = fakeDb()
    const r = await applyFormPortalAccess({ ...base, ticked: false, isSs4Signer: true, db })
    expect(r).toEqual({ action: "none" })
    expect(calls).toHaveLength(0)
  })

  it("reports 'no change' when nothing matched — the link was already marked, or the team has decided on it (QA 21 Nov 2026)", async () => {
    const { db } = fakeDb(null, 0)
    expect(await applyFormPortalAccess({ ...base, ticked: false, db })).toEqual({ action: "none" })
  })

  it("reports the mark when a row was written", async () => {
    const { db } = fakeDb(null, 1)
    expect(await applyFormPortalAccess({ ...base, ticked: false, db })).toEqual({ action: "mark" })
  })

  it("a ticked signer still goes through the normal lift (only a mark the form itself put there)", async () => {
    const { db, calls } = fakeDb()
    const r = await applyFormPortalAccess({ ...base, ticked: true, isSs4Signer: true, db })
    expect(r).toEqual({ action: "lift" })
    expect(calls).toHaveLength(1)
  })

  it("the mark is only written when nobody on the team has decided on the link (a Give keeps the team member's id there)", async () => {
    const { db, calls } = fakeDb()
    await applyFormPortalAccess({ ...base, ticked: false, db })
    expect(calls[0].filters).toContainEqual(["is", "access_revoked_by", null])
  })

  it("never writes anything but the mark: no delete, no membership change", async () => {
    const { db, calls } = fakeDb()
    await applyFormPortalAccess({ ...base, ticked: false, db })
    expect(Object.keys(calls[0].values)).toEqual(["access_revoked_at"])
  })

  it("ticked lifts only a mark the form put there (nobody in access_revoked_by)", async () => {
    const { db, calls } = fakeDb()
    const r = await applyFormPortalAccess({ ...base, ticked: true, db })
    expect(r).toEqual({ action: "lift" })
    expect(calls[0].values).toEqual({ access_revoked_at: null })
    expect(calls[0].filters).toEqual([
      ["eq", "account_id", "acc-1"],
      ["eq", "contact_id", "member-1"],
      ["not", "access_revoked_at", "is", null],
      ["is", "access_revoked_by", null],
    ])
  })

  it("no answer (an older form, or the switch was off) changes nothing", async () => {
    const { db, calls } = fakeDb()
    expect(await applyFormPortalAccess({ ...base, ticked: null, db })).toEqual({ action: "none" })
    expect(await applyFormPortalAccess({ ...base, ticked: undefined, db })).toEqual({ action: "none" })
    expect(calls).toHaveLength(0)
  })

  it("never marks the person filling the form", async () => {
    const { db, calls } = fakeDb()
    const r = await applyFormPortalAccess({ ...base, contactId: "owner-1", ticked: false, db })
    expect(r).toEqual({ action: "none" })
    expect(calls).toHaveLength(0)
  })

  it("reports a database refusal as text instead of throwing", async () => {
    const { db } = fakeDb("permission denied")
    expect(await applyFormPortalAccess({ ...base, ticked: false, db })).toEqual({ action: "mark", error: "permission denied" })
    expect(await applyFormPortalAccess({ ...base, ticked: true, db })).toEqual({ action: "lift", error: "permission denied" })
  })
})
