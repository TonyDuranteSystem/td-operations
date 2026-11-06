import { describe, it, expect, vi, beforeEach } from "vitest"

// The files the wizard filed are looked up by the saver's exact keys and listed on the job (staff-only, no step stamp, idempotent).
const h = vi.hoisted(() => ({
  rows: { summary: [] as Array<{ id: string; name: string }>, uploads: [] as Array<{ id: string; name: string }> },
  err: null as string | null,
  calls: [] as Array<{ kind: string; arg: string }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = (_c: string, v: string) => { h.calls.push({ kind: "eq", arg: v }); q.which = "summary"; return q }
      q.like = (_c: string, v: string) => { h.calls.push({ kind: "like", arg: v }); q.which = "uploads"; return q }
      q.is = () => q
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(h.err ? { data: null, error: { message: h.err } } : { data: h.rows[q.which as "summary" | "uploads"], error: null }).then(res)
      return q
    },
  },
}))

import { registerClosurePackageDocuments } from "@/lib/forms/closure-documents"

const upsert = vi.fn()
const input = { storageOwnerId: "6f1c2b3a-1111-4222-8333-444455556666" as string | null, token: "tok-1", contactId: "contact-1", accountId: null as string | null, serviceDeliveryId: "sd-1" }

beforeEach(() => {
  vi.clearAllMocks(); h.calls.length = 0; h.err = null
  h.rows.summary = [{ id: "f-sum", name: "Closure_Data_X.pdf" }]
  h.rows.uploads = [{ id: "f-art", name: "articles.pdf" }, { id: "f-ein", name: "ein_letter.pdf" }]
  upsert.mockImplementation(async (id: string) => ({ id: `doc-${id}`, inserted: true }))
})

describe("registerClosurePackageDocuments", () => {
  it("lists the summary and every upload on the job, staff-only, with NO step stamp", async () => {
    const r = await registerClosurePackageDocuments(input, { upsert })
    expect(r).toEqual({ registered: 3, inserted: 3 })
    expect(upsert).toHaveBeenCalledTimes(3)
    for (const [, row] of upsert.mock.calls) {
      expect(row).toMatchObject({ service_delivery_id: "sd-1", contact_id: "contact-1", account_id: null, flow_stage: null, portal_visible: false })
    }
    expect(upsert.mock.calls.map((c) => c[0])).toEqual(["f-sum", "f-art", "f-ein"])
    expect(upsert.mock.calls[0][1].file_name).toBe("Closure_Data_X.pdf")
  })

  it("finds the files by the saver's exact keys (owner id : closure : token)", async () => {
    await registerClosurePackageDocuments(input, { upsert })
    expect(h.calls).toContainEqual({ kind: "eq", arg: "form-summary:6f1c2b3a-1111-4222-8333-444455556666:closure:tok-1" })
    expect(h.calls).toContainEqual({ kind: "like", arg: "form-upload:6f1c2b3a-1111-4222-8333-444455556666:closure:tok-1:%" })
  })

  it("a company that kept its Drive folder id: its files are found by the COMPANY's id (the saver keys them by the owner)", async () => {
    await registerClosurePackageDocuments({ ...input, storageOwnerId: "7a2d3c4b-2222-4333-8444-555566667777", accountId: "acc-a" }, { upsert })
    expect(h.calls).toContainEqual({ kind: "eq", arg: "form-summary:7a2d3c4b-2222-4333-8444-555566667777:closure:tok-1" })
    expect(upsert).toHaveBeenCalledTimes(3)
  })

  it("a company link on the job is carried onto the listed files", async () => {
    await registerClosurePackageDocuments({ ...input, accountId: "acc-a" }, { upsert })
    expect(upsert.mock.calls[0][1]).toMatchObject({ account_id: "acc-a", portal_visible: false })
  })

  it("a retry or a correction adds nothing new (inserted counts only the new rows)", async () => {
    upsert.mockImplementation(async (id: string) => ({ id: `doc-${id}`, inserted: false }))
    expect(await registerClosurePackageDocuments(input, { upsert })).toEqual({ registered: 3, inserted: 0 })
  })

  it("a package that was not filed in the CRM storage (no owner) lists nothing and reads nothing", async () => {
    expect(await registerClosurePackageDocuments({ ...input, storageOwnerId: null }, { upsert })).toEqual({ registered: 0, inserted: 0 })
    expect(upsert).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
  })

  it("nothing filed yet: nothing listed", async () => {
    h.rows.summary = []; h.rows.uploads = []
    expect(await registerClosurePackageDocuments(input, { upsert })).toEqual({ registered: 0, inserted: 0 })
  })

  it("a read error THROWS (the caller reports an error step and the job retries)", async () => {
    h.err = "db down"
    await expect(registerClosurePackageDocuments(input, { upsert })).rejects.toThrow(/could not read/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it("a write error THROWS too", async () => {
    upsert.mockRejectedValueOnce(new Error("insert refused"))
    await expect(registerClosurePackageDocuments(input, { upsert })).rejects.toThrow(/insert refused/)
  })
})
