/**
 * Unit tests for the SS-4 "Resubmit" core (lib/operations/ss4-resubmit.ts).
 * The database step (resubmit_ss4) is exercised against the sandbox database; here we pin the ORDER and the guards:
 * every check runs before anything is archived, a failure archives nothing, the corrected SS-4 gets a token that cannot
 * clash, and the old SS-4's documents are relabelled so the new one's files are unambiguous.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  old: null as null | Record<string, unknown>,
  archivedCount: 0,
  liveTokens: [] as Array<{ token: string }>,
  docs: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  docUpdates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  docDeletes: [] as string[],
  prepare: vi.fn(),
  finish: vi.fn(),
  classify: vi.fn(),
  rename: vi.fn(),
  closeTasks: vi.fn(),
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  insertError: null as null | { message: string },
  sd: null as null | Record<string, unknown>,
}))

function builder(table: string) {
  const ctx: { filters: Record<string, unknown>; op: string; patch?: Record<string, unknown>; head?: boolean } = { filters: {}, op: "select" }
  const b: Record<string, unknown> = {}
  const resolve = () => {
    if (table === "ss4_applications" && ctx.op === "select" && ctx.filters.like) return { data: state.liveTokens, error: null }
    if (table === "ss4_applications_archive") return { count: state.archivedCount, data: null, error: null }
    if (table === "documents" && ctx.op === "select") return { data: state.docs, error: null }
    if (table === "documents" && ctx.op === "delete") return { data: [{ id: ctx.filters.id }], error: null }
    if (table === "action_log" && ctx.op === "insert") return { data: null, error: state.insertError }
    return { data: null, error: null }
  }
  for (const m of ["select", "eq", "in", "like", "order", "limit"]) {
    b[m] = (...a: unknown[]) => {
      if (m === "eq") ctx.filters[a[0] as string] = a[1]
      if (m === "like") ctx.filters.like = a[1]
      return b
    }
  }
  b.update = (patch: Record<string, unknown>) => { ctx.op = "update"; ctx.patch = patch; return b }
  b.delete = () => { ctx.op = "delete"; return b }
  b.insert = (row: Record<string, unknown>) => { ctx.op = "insert"; state.inserts.push({ table, row }); return b }
  b.maybeSingle = async () => {
    if (table === "ss4_applications") return { data: state.old, error: null }
    if (table === "service_deliveries") return { data: state.sd, error: null }
    return { data: null, error: null }
  }
  b.then = (res: (v: unknown) => unknown) => {
    if (table === "documents" && ctx.op === "update") state.docUpdates.push({ id: ctx.filters.id as string, patch: ctx.patch! })
    if (table === "documents" && ctx.op === "delete") state.docDeletes.push(ctx.filters.id as string)
    return Promise.resolve(resolve()).then(res)
  }
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => builder(t), rpc: (...a: unknown[]) => state.rpc(...a) },
}))
vi.mock("@/lib/operations/ss4-refresh", () => ({
  classifySs4Party: (...a: unknown[]) => state.classify(...a),
  resolveEntityType: (x: string | null) => x ?? "SMLLC",
}))
vi.mock("@/lib/crm-store/file-actions", () => ({ renameStoreFile: (...a: unknown[]) => state.rename(...a) }))
vi.mock("@/lib/operations/task", () => ({ updateTasksBulk: (...a: unknown[]) => state.closeTasks(...a) }))
vi.mock("@/lib/operations/ss4", () => ({
  prepareSS4: (...a: unknown[]) => state.prepare(...a),
  finishSS4Create: (...a: unknown[]) => state.finish(...a),
}))

import { resubmitSs4, resubmitToken, RESUBMITTABLE_STATUSES } from "@/lib/operations/ss4-resubmit"

const ACC = "acc-1"
const baseRow = { token: "ss4-tanto-per-llc-2026", access_code: "newcode1", status: "draft", county_and_state: "Bernalillo County, New Mexico" }

beforeEach(() => {
  state.old = { id: "old-1", token: "ss4-tanto-per-llc-2026", status: "signed", contact_id: "c-1", entity_type: "SMLLC", county_and_state: "Sheridan County, Wyoming", company_name: "Tanto per LLC" }
  state.archivedCount = 0
  state.liveTokens = []
  state.docs = []
  state.docUpdates = []
  state.docDeletes = []
  state.rpc = vi.fn().mockResolvedValue({ data: "new-1", error: null })
  state.prepare = vi.fn().mockResolvedValue({ ok: true, outcome: "created", prepared: { row: { ...baseRow }, company_name: "Tanto per LLC" } })
  state.finish = vi.fn().mockResolvedValue({ ok: true, outcome: "created", previewUrl: "https://x/preview" })
  state.classify = vi.fn().mockResolvedValue("member_derived")
  state.rename = vi.fn().mockResolvedValue({ name: "x" })
  state.closeTasks = vi.fn().mockResolvedValue({ success: true, outcome: "updated", count: 1, ids: ["t1"] })
  state.inserts = []
  state.insertError = null
  state.sd = { id: "sd-1", stage_history: [] }
})

describe("resubmitToken", () => {
  it("adds -r<n> after the archived ones so it can never clash", () => {
    expect(resubmitToken("ss4-a-2026", 0, new Set())).toBe("ss4-a-2026-r1")
    expect(resubmitToken("ss4-a-2026", 1, new Set())).toBe("ss4-a-2026-r2")
  })
  it("skips a token that is already live", () => {
    expect(resubmitToken("ss4-a-2026", 0, new Set(["ss4-a-2026-r1", "ss4-a-2026-r2"]))).toBe("ss4-a-2026-r3")
  })
})

describe("resubmitSs4 guards", () => {
  it("requires a reason and touches nothing without one", async () => {
    const r = await resubmitSs4({ account_id: ACC, reason: "  ", by: "t", source: "test" })
    expect(r.outcome).toBe("reason_required")
    expect(state.prepare).not.toHaveBeenCalled()
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("only signed / submitted / done / fax_failed can be resubmitted", () => {
    expect([...RESUBMITTABLE_STATUSES]).toEqual(["signed", "submitted", "done", "fax_failed"])
  })

  it("a draft or awaiting SS-4 points to Regenerate instead and archives nothing", async () => {
    for (const status of ["draft", "awaiting_signature"]) {
      state.old = { ...state.old!, status }
      const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
      expect(r.outcome).toBe("not_resubmittable")
      expect(r.message).toContain("Regenerate")
    }
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("no SS-4 at all → no_ss4", async () => {
    state.old = null
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.outcome).toBe("no_ss4")
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it("a wrong-state registered agent stops it BEFORE anything is archived", async () => {
    state.prepare = vi.fn().mockResolvedValue({ ok: false, outcome: "ra_state_mismatch", message: "The registered agent is in Wyoming." })
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe("ra_state_mismatch")
    expect(r.message).toContain("Nothing was archived")
    expect(state.rpc).not.toHaveBeenCalled()
    expect(state.finish).not.toHaveBeenCalled()
  })

  it("runs the new-SS-4 checks with the SAME signer and skips only the already-exists stop", async () => {
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.prepare).toHaveBeenCalledWith({ account_id: ACC, contact_id: "c-1" }, { allowExisting: true })
  })
})

describe("resubmitSs4 success path", () => {
  it("archives + inserts in one database step with a clash-proof token and the reason", async () => {
    const r = await resubmitSs4({ account_id: ACC, reason: "Wrong registered agent address", by: "luca@x", source: "test" })
    expect(r.ok).toBe(true)
    expect(r.outcome).toBe("resubmitted")
    expect(state.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = state.rpc.mock.calls[0]
    expect(fn).toBe("resubmit_ss4")
    expect(args.p_old_id).toBe("old-1")
    expect(args.p_reason).toBe("Wrong registered agent address")
    expect(args.p_by).toBe("luca@x")
    expect(args.p_new.token).toBe("ss4-tanto-per-llc-2026-r1")
    expect(r.ss4?.token).toBe("ss4-tanto-per-llc-2026-r1")
    expect(r.ss4?.status).toBe("draft")
    expect(r.message).toContain("Sheridan County, Wyoming")
    expect(r.message).toContain("Bernalillo County, New Mexico")
    expect(r.message).toContain("Nothing has been sent to the client")
  })

  it("a second resubmit gets -r2 and a live -r1 is skipped", async () => {
    state.archivedCount = 1
    state.liveTokens = [{ token: "ss4-tanto-per-llc-2026-r2" }]
    await resubmitSs4({ account_id: ACC, reason: "again", by: "t", source: "test" })
    expect(state.rpc.mock.calls[0][1].p_new.token).toBe("ss4-tanto-per-llc-2026-r3")
  })

  it("the corrected SS-4 is created as a draft — never armed for the client", async () => {
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ss4?.status).toBe("draft")
    expect(state.finish.mock.calls[0][1].status).toBe("draft")
  })

  it("a database failure reports the old SS-4 intact and builds nothing", async () => {
    state.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } })
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("previous SS-4 is intact")
    expect(state.finish).not.toHaveBeenCalled()
    expect(state.docUpdates).toHaveLength(0)
  })

  it("relabels the old stored copies and removes the old live-document row", async () => {
    state.docs = [
      { id: "d-live", file_name: "SS-4 - Tanto per LLC.pdf", document_type_name: "SS-4", drive_file_id: "ss4-live:ss4-tanto-per-llc-2026" },
      { id: "d-unsigned", file_name: "Form SS-4 - Tanto per LLC - Unsigned.pdf", document_type_name: "Form SS-4 (Unsigned)", drive_file_id: "store:1" },
      { id: "d-signed", file_name: "Form SS-4 - Tanto per LLC - Signed.pdf", document_type_name: "Form SS-4 (Signed)", drive_file_id: "store:2" },
      { id: "d-pkg", file_name: "Form SS-4 - Tanto per LLC - For IRS.pdf", document_type_name: "SS-4 + Articles (IRS Package)", drive_file_id: "store:3" },
    ]
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(true)
    expect(state.docDeletes).toEqual(["d-live"])
    expect(state.docUpdates.map((u) => u.id).sort()).toEqual(["d-pkg", "d-signed", "d-unsigned"])
    const signed = state.docUpdates.find((u) => u.id === "d-signed")!
    expect(signed.patch.document_type_name).toBe("Form SS-4 (Signed) (Replaced)")
    expect(String(signed.patch.file_name)).toMatch(/Signed \(replaced \d{4}-\d{2}-\d{2} \d{4}\)\.pdf$/)
  })

  it("closes the old SS-4's open fax tasks and writes the marker the fax panel reads", async () => {
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "luca@x", source: "test" })
    expect(r.ok).toBe(true)
    expect(state.closeTasks).toHaveBeenCalledTimes(1)
    expect(state.closeTasks.mock.calls[0][0]).toMatchObject({ account_id: ACC, title_ilike: "%Fax%SS-4%", patch: { status: "Done" } })
    const marker = state.inserts.find((i) => i.table === "action_log")!
    expect(marker.row.action_type).toBe("ss4_resubmitted")
    expect(marker.row.service_delivery_id).toBe("sd-1")
    expect((marker.row.details as Record<string, unknown>).reason).toBe("wrong agent")
  })
})

describe("resubmitSs4 after the archive step (the old SS-4 is already archived)", () => {
  it("a failing set-up step is reported as a warning — never as 'nothing was changed'", async () => {
    state.finish = vi.fn().mockRejectedValue(new Error("boom"))
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(true)
    expect(r.outcome).toBe("resubmitted")
    expect(r.message).not.toContain("Nothing was changed")
    expect(r.warnings?.join(" ")).toContain("Setting up the corrected SS-4 did not finish")
    // the later steps still ran
    expect(state.closeTasks).toHaveBeenCalled()
  })

  it("a set-up that returns not-ok is also a warning", async () => {
    state.finish = vi.fn().mockResolvedValue({ ok: false, outcome: "error", message: "pdf failed" })
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(true)
    expect(r.warnings?.join(" ")).toContain("pdf failed")
  })

  it("one document that cannot be relabelled does not stop the others", async () => {
    state.docs = [
      { id: "d-a", file_name: "A.pdf", document_type_name: "Form SS-4 (Unsigned)", drive_file_id: "store:1" },
      { id: "d-b", file_name: "B.pdf", document_type_name: "Form SS-4 (Signed)", drive_file_id: "store:2" },
    ]
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(true)
    expect(state.docUpdates.map((u) => u.id).sort()).toEqual(["d-a", "d-b"])
  })

  it("a live document row of a DIFFERENT token is left alone", async () => {
    state.docs = [{ id: "d-other", file_name: "SS-4.pdf", document_type_name: "SS-4", drive_file_id: "ss4-live:some-other-token" }]
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.docDeletes).toEqual([])
  })

  it("an already-replaced document is not relabelled twice", async () => {
    state.docs = [{ id: "d-x", file_name: "x (replaced 2026-10-01).pdf", document_type_name: "Form SS-4 (Signed) (Replaced)", drive_file_id: "store:9" }]
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.docUpdates).toEqual([])
  })
})

describe("resubmitSs4 stored files", () => {
  it("renames each old stored copy in the storage too (so the corrected SS-4 gets the clean name)", async () => {
    state.docs = [
      { id: "d-unsigned", file_name: "Form SS-4 - Tanto per LLC - Unsigned.pdf", document_type_name: "Form SS-4 (Unsigned)", drive_file_id: "store:aaaaaaaa-0000-4000-8000-000000000001" },
      { id: "d-signed", file_name: "Form SS-4 - Tanto per LLC - Signed.pdf", document_type_name: "Form SS-4 (Signed)", drive_file_id: "storage:signed-ss4/x.pdf" },
    ]
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.rename).toHaveBeenCalledTimes(1) // only the store: copy; a storage: path is not a store file
    expect(String(state.rename.mock.calls[0][1])).toMatch(/Unsigned \(replaced \d{4}-\d{2}-\d{2} \d{4}\)\.pdf$/)
  })

  it("a storage rename that fails is a warning, and the CRM row is still relabelled", async () => {
    state.rename = vi.fn().mockRejectedValue(new Error("locked"))
    state.docs = [{ id: "d-unsigned", file_name: "U.pdf", document_type_name: "Form SS-4 (Unsigned)", drive_file_id: "store:aaaaaaaa-0000-4000-8000-000000000001" }]
    const r = await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(r.ok).toBe(true)
    expect(r.warnings?.join(" ")).toContain("could not be renamed in the storage")
    expect(state.docUpdates.map((u) => u.id)).toEqual(["d-unsigned"])
  })
})

describe("resubmitSs4 signer", () => {
  it("keeps the old signer while that person is still a member", async () => {
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.prepare).toHaveBeenCalledWith({ account_id: ACC, contact_id: "c-1" }, { allowExisting: true })
  })

  it("does NOT carry over a signer who is no longer one of the members (worked out again from today's members)", async () => {
    state.classify = vi.fn().mockResolvedValue("orphaned")
    await resubmitSs4({ account_id: ACC, reason: "wrong agent", by: "t", source: "test" })
    expect(state.prepare).toHaveBeenCalledWith({ account_id: ACC, contact_id: undefined }, { allowExisting: true })
  })
})
