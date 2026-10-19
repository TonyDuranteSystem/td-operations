/**
 * Stop Drive, slice S1c round 5: the closure form's filing rule (marker + upload bucket) and the finished-company rule for tax forms.
 */
import { describe, it, expect, vi } from "vitest"
import { fileClosureSubmission, closureBucketFor, describeFilingForAccount, type ClosureFilingDeps } from "@/lib/crm-store/save-account-form"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))

const FILED = { route: "store", result: { summaryFileId: "store:s", copied: ["a.pdf"], failed: [] as string[], skipped: [] as string[], errors: [] as string[] } } as never
const NONE = { route: "none" } as never
const sub = { id: "cl-1", token: "tok", account_id: "acct-1", upload_paths: ["tok123/a.pdf", "onboarding/y/b.pdf"], completed_at: "2026-10-01" }

function deps(over: Partial<ClosureFilingDeps> = {}) {
  const calls = { saved: [] as Array<Record<string, unknown>>, marked: [] as Array<[string, string]>, alarms: 0 }
  const d: ClosureFilingDeps = {
    save: async (i) => { calls.saved.push(i as unknown as Record<string, unknown>); return FILED },
    saveForContact: async (i) => { calls.saved.push(i as unknown as Record<string, unknown>); return FILED },
    finished: async () => false,
    markFiled: async (id, where) => { calls.marked.push([id, where]) },
    alarm: async () => { calls.alarms++ },
    ...over,
  }
  return { d, calls }
}

describe("closureBucketFor", () => {
  it("a wizard upload comes from the onboarding bucket, an external-form upload from the closure bucket", () => {
    expect(closureBucketFor("tok123/a.pdf")).toBe("closure-uploads")
    expect(closureBucketFor("onboarding/y/b.pdf")).toBe("onboarding-uploads")
  })
})

describe("fileClosureSubmission", () => {
  it("filed in storage → the durable 'filed' marker is set (so the sweep never files it again), and the per-file bucket resolver is passed", async () => {
    const { d, calls } = deps()
    const out = await fileClosureSubmission(sub, {}, "Acme LLC", "/r", d)
    expect(out.ok).toBe(true)
    expect(calls.marked).toEqual([["cl-1", "storage"]])
    expect(calls.saved[0].resolveBucket).toBe(closureBucketFor)
  })

  it("a person-only closure is filed through the person's storage with the same marker and resolver", async () => {
    const { d, calls } = deps()
    const out = await fileClosureSubmission({ ...sub, account_id: null, contact_id: "c-1" }, {}, "Acme LLC", "/r", d)
    expect(out.ok).toBe(true)
    expect(calls.saved[0]).toMatchObject({ contactId: "c-1", resolveBucket: closureBucketFor })
    expect(calls.marked).toEqual([["cl-1", "storage"]])
  })

  it("nothing could be saved → no marker, not reviewable", async () => {
    const { d, calls } = deps({ save: async () => NONE })
    const out = await fileClosureSubmission(sub, {}, "Acme LLC", "/r", d)
    expect(out.ok).toBe(false)
    expect(calls.marked).toEqual([])
  })

  it("a Closed / Cancelled company: nothing to file, reviewable, no marker, and it says the uploads stay in the upload area", async () => {
    const { d, calls } = deps({ save: async () => NONE, finished: async () => true })
    const out = await fileClosureSubmission(sub, {}, "Acme LLC", "/r", d)
    expect(out.ok).toBe(true)
    expect(out.lines.join(" ")).toContain("uploaded files stay in the upload area")
    expect(calls.marked).toEqual([])
  })

  it("a marker that cannot be written does not undo the filing", async () => {
    const { d } = deps({ markFiled: async () => { throw new Error("db") } })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await fileClosureSubmission(sub, {}, "Acme LLC", "/r", d)
    expect(out.ok).toBe(true)
    spy.mockRestore()
  })
})

describe("describeFilingForAccount (tax forms)", () => {
  it("a Closed / Cancelled company: handled without filing (ok), says so plainly", async () => {
    const r = await describeFilingForAccount(NONE, "acct-1", async () => true)
    expect(r.ok).toBe(true)
    expect(r.lines.join(" ")).toContain("closed")
  })
  it("any other company that can receive nothing is NOT ok (the form is not marked reviewed)", async () => {
    const r = await describeFilingForAccount(NONE, "acct-1", async () => false)
    expect(r.ok).toBe(false)
  })
  it("a read error is treated as 'not finished' — never silently passed", async () => {
    const r = await describeFilingForAccount(NONE, "acct-1", async () => { throw new Error("down") })
    expect(r.ok).toBe(false)
  })
  it("a normal filing is described as before", async () => {
    const r = await describeFilingForAccount(FILED, "acct-1", async () => { throw new Error("must not be asked") })
    expect(r.ok).toBe(true)
  })
})
