import { describe, it, expect, vi, beforeEach } from "vitest"
import type { User } from "@supabase/supabase-js"

let cookieUser: User | null = null
const getUser = vi.fn(async () => ({ data: { user: cookieUser } }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser } }) }))

import { denyUnlessStoreStaff } from "@/app/api/crm-store/browse/_auth"

const u = (role: unknown, user_metadata: Record<string, unknown> = {}): User => ({ id: "x", app_metadata: { role }, user_metadata } as unknown as User)

describe("the Storage page's staff check takes the Mac app's user as well as the cookie's", () => {
  beforeEach(() => { getUser.mockClear(); cookieUser = null })

  it("without a passed user it reads the cookie login, exactly as before", async () => {
    cookieUser = u("team")
    expect(await denyUnlessStoreStaff()).toBeNull()
    expect(getUser).toHaveBeenCalledTimes(1)
    cookieUser = u("client")
    expect((await denyUnlessStoreStaff())?.status).toBe(403)
  })
  it("a passed user is used INSTEAD of the cookie (the cookie is not even read)", async () => {
    cookieUser = u("client")                                   // a stale browser login must not matter
    expect(await denyUnlessStoreStaff(u("admin"))).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
  })
  it("a passed null means nobody is signed in — refused, cookie not read", async () => {
    cookieUser = u("admin")
    expect((await denyUnlessStoreStaff(null))?.status).toBe(403)
    expect(getUser).not.toHaveBeenCalled()
  })
  it("the cookie path and the passed-user path give the SAME answer for every kind of login", async () => {
    for (const [role, meta] of [["admin", {}], ["team", {}], ["client", {}], ["partner", {}], [undefined, {}], ["", {}], [undefined, { role: "admin" }]] as Array<[unknown, Record<string, unknown>]>) {
      cookieUser = u(role, meta)
      const viaCookie = (await denyUnlessStoreStaff())?.status ?? 200
      const viaPassed = (await denyUnlessStoreStaff(u(role, meta)))?.status ?? 200
      expect(viaPassed, `role=${String(role)} meta=${JSON.stringify(meta)}`).toBe(viaCookie)
    }
  })
})
