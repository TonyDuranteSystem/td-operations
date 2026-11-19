/**
 * The portal's one question "which companies can this person open?" (getClientAccountIds) must leave out a company
 * link that carries the no-access mark. Dev job beb43385, delivery A.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { calls, rows } = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  rows: { value: [] as Array<{ account_id: string }> },
}))

vi.mock("@/lib/supabase-admin", () => {
  const builder: Record<string, unknown> = {}
  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args })
    return builder
  }
  builder.from = chain("from")
  builder.select = chain("select")
  builder.eq = chain("eq")
  builder.is = chain("is")
  // awaiting the builder returns the rows
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows.value, error: null })
  return { supabaseAdmin: builder }
})

import { getClientAccountIds } from "@/lib/portal-auth"

beforeEach(() => {
  calls.length = 0
  rows.value = []
})

describe("getClientAccountIds", () => {
  it("asks only for links without the no-access mark", async () => {
    rows.value = [{ account_id: "acc-1" }, { account_id: "acc-2" }]
    const ids = await getClientAccountIds("contact-1")
    expect(ids).toEqual(["acc-1", "acc-2"])
    expect(calls).toContainEqual({ method: "is", args: ["access_revoked_at", null] })
    expect(calls).toContainEqual({ method: "eq", args: ["contact_id", "contact-1"] })
  })

  it("returns nothing when every link carries the mark (the database answers with no rows)", async () => {
    rows.value = []
    expect(await getClientAccountIds("contact-1")).toEqual([])
  })
})
