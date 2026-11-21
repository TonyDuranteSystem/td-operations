/**
 * The off / test / on switch of the per-member "portal access" tick (dev job beb43385, delivery B).
 * Fails CLOSED: a missing row, a failed read, an unknown value, a record that cannot be read — all mean off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  stored: undefined as unknown,
  throwOnRead: false,
  record: { data: null as unknown, error: null as null | { message: string } },
  recordReads: [] as string[],
}))

vi.mock("@/lib/settings", () => ({
  getAppSetting: async (_key: string, fallback: unknown) => {
    if (h.throwOnRead) throw new Error("settings down")
    return h.stored === undefined ? fallback : h.stored
  },
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_c: string, id: string) => { h.recordReads.push(`${table}:${id}`); return chain },
        maybeSingle: async () => h.record,
      }
      return chain
    },
  },
}))

import { memberPortalAccessMode, memberPortalAccessOn, MEMBER_PORTAL_ACCESS_KEY } from "@/lib/portal/member-access-switch"

const ACCT = "11111111-1111-4111-8111-111111111111"
const CONTACT = "33333333-3333-4333-8333-333333333333"

beforeEach(() => {
  h.stored = undefined
  h.throwOnRead = false
  h.record = { data: null, error: null }
  h.recordReads = []
})

describe("member portal access switch", () => {
  it("uses its own stored key", () => {
    expect(MEMBER_PORTAL_ACCESS_KEY).toBe("member_portal_access_enabled")
  })

  it("is off when nothing is stored", async () => {
    expect(await memberPortalAccessMode()).toBe("off")
    expect(await memberPortalAccessOn({ accountId: ACCT })).toBe(false)
  })

  it.each([false, "true", "on", "TEST", 1, null, {}, []])("reads %j as off", async (value) => {
    h.stored = value
    expect(await memberPortalAccessMode()).toBe("off")
    expect(await memberPortalAccessOn({ accountId: ACCT })).toBe(false)
  })

  it("is off when the settings read fails", async () => {
    h.throwOnRead = true
    expect(await memberPortalAccessMode()).toBe("off")
    expect(await memberPortalAccessOn({ accountId: ACCT })).toBe(false)
  })

  it("is on for everybody when the stored value is the boolean true, without looking the record up", async () => {
    h.stored = true
    expect(await memberPortalAccessOn({ accountId: ACCT })).toBe(true)
    expect(await memberPortalAccessOn({})).toBe(true)
    expect(h.recordReads).toEqual([])
  })

  it('in "test" mode only a record marked as test sees it', async () => {
    h.stored = "test"
    h.record = { data: { is_test: true }, error: null }
    expect(await memberPortalAccessOn({ contactId: CONTACT })).toBe(true)
    h.record = { data: { is_test: false }, error: null }
    expect(await memberPortalAccessOn({ contactId: CONTACT })).toBe(false)
    h.record = { data: { is_test: null }, error: null }
    expect(await memberPortalAccessOn({ contactId: CONTACT })).toBe(false)
  })

  it('in "test" mode the company decides before the contact', async () => {
    h.stored = "test"
    h.record = { data: { is_test: true }, error: null }
    await memberPortalAccessOn({ accountId: ACCT, contactId: CONTACT })
    expect(h.recordReads).toEqual([`accounts:${ACCT}`])
  })

  it('in "test" mode an unknown, unreadable or missing record is never a test record', async () => {
    h.stored = "test"
    expect(await memberPortalAccessOn({})).toBe(false)
    expect(await memberPortalAccessOn({ accountId: "not-a-uuid" })).toBe(false)
    h.record = { data: null, error: { message: "boom" } }
    expect(await memberPortalAccessOn({ contactId: CONTACT })).toBe(false)
    h.record = { data: null, error: null }
    expect(await memberPortalAccessOn({ contactId: CONTACT })).toBe(false)
  })
})
