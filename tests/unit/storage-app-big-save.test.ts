import { describe, it, expect, vi } from "vitest"

// registerJobState reads the background-job table; the table is faked here so the three answers can be checked without a database.
let rows: Array<{ status: string }> = []
let failWith: { message: string } | null = null
vi.mock("@/lib/supabase-admin", () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.limit = () => Promise.resolve({ data: failWith ? null : rows, error: failWith })
  return { supabaseAdmin: { from: () => chain } }
})

import { registerJobState } from "@/lib/storage-app/save"

describe("registerJobState — where a big file's background save stands", () => {
  it("no job was ever queued → null (a small file, or the first ask)", async () => {
    rows = []; failWith = null
    expect(await registerJobState("i1")).toBeNull()
  })
  it("a queued or running job → active (the Mac is told 'pending' and asks again, no second job is queued)", async () => {
    failWith = null
    for (const s of ["pending", "processing"]) { rows = [{ status: s }]; expect(await registerJobState("i1")).toBe("active") }
    rows = [{ status: "failed" }, { status: "processing" }]       // an old failed try next to a running one: still active
    expect(await registerJobState("i1")).toBe("active")
  })
  it("every try ended without a file → failed (the Mac is told so and the money share is given back)", async () => {
    failWith = null
    rows = [{ status: "failed" }]; expect(await registerJobState("i1")).toBe("failed")
    rows = [{ status: "cancelled" }]; expect(await registerJobState("i1")).toBe("failed")
  })
  it("a database error is an error, never a guess", async () => {
    failWith = { message: "down" }
    await expect(registerJobState("i1")).rejects.toThrow(/background save/)
  })
})
