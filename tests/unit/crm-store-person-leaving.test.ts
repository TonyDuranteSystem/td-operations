import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { endPortalAccessForRemovedMember, type LeavingDb } from "@/lib/crm-store/person-leaving"

/** A tiny fake of the three tables the function touches. */
function fakeDb(o: { stillMember?: number; link?: { is_primary: boolean } | null; deleteError?: string | null; throwOn?: string }) {
  const deleted: Array<Record<string, string>> = []
  const db = {
    from(table: string) {
      if (o.throwOn === table) throw new Error("boom")
      if (table === "members") {
        return { select: () => ({ eq: () => ({ eq: async () => ({ count: o.stillMember ?? 0 }) }) }) }
      }
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: o.link ?? null }) }) }) }),
        delete: () => ({ eq: (c1: string, v1: string) => ({ eq: async (c2: string, v2: string) => { deleted.push({ [c1]: v1, [c2]: v2 }); return { error: o.deleteError ? { message: o.deleteError } : null } } }) }),
      }
    },
  } as unknown as LeavingDb
  return { db, deleted }
}
const P = { accountId: "acc", contactId: "con", memberType: "individual" }

describe("endPortalAccessForRemovedMember", () => {
  it("ends the portal link of a removed person member", async () => {
    const { db, deleted } = fakeDb({ link: { is_primary: false } })
    expect(await endPortalAccessForRemovedMember(P, db)).toEqual({ accessEnded: true, warning: null })
    expect(deleted).toEqual([{ account_id: "acc", contact_id: "con" }])
  })
  it("never touches a company member or a member without a contact record", async () => {
    const { db, deleted } = fakeDb({ link: { is_primary: false } })
    expect(await endPortalAccessForRemovedMember({ ...P, memberType: "company" }, db)).toEqual({ accessEnded: false, warning: null })
    expect(await endPortalAccessForRemovedMember({ ...P, contactId: null }, db)).toEqual({ accessEnded: false, warning: null })
    expect(deleted).toEqual([])
  })
  it("keeps access while the person is still another member of this company", async () => {
    const { db, deleted } = fakeDb({ stillMember: 1, link: { is_primary: false } })
    const r = await endPortalAccessForRemovedMember(P, db)
    expect(r.accessEnded).toBe(false)
    expect(r.warning).toMatch(/still listed as another member/)
    expect(deleted).toEqual([])
  })
  it("keeps access for the primary contact and says so", async () => {
    const { db, deleted } = fakeDb({ link: { is_primary: true } })
    const r = await endPortalAccessForRemovedMember(P, db)
    expect(r.accessEnded).toBe(false)
    expect(r.warning).toMatch(/primary contact/)
    expect(deleted).toEqual([])
  })
  it("a person with no portal link has nothing to end (no warning)", async () => {
    const { db } = fakeDb({ link: null })
    expect(await endPortalAccessForRemovedMember(P, db)).toEqual({ accessEnded: false, warning: null })
  })
  it("a failed delete or a thrown error is reported, never thrown", async () => {
    expect((await endPortalAccessForRemovedMember(P, fakeDb({ link: { is_primary: false }, deleteError: "x" }).db)).warning).toMatch(/could not be ended/)
    expect((await endPortalAccessForRemovedMember(P, fakeDb({ throwOn: "members" }).db)).warning).toMatch(/could not be checked/)
  })
})
