import { describe, it, expect, vi } from "vitest"

// Bug hunt 2026-11-06 — the retry job's pinned plan, the staff review, and the transient-error screen.
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => { throw new Error("not used here") } } }))

import { pinnedPlan } from "@/lib/forms/archive-submission"
import { pinnedPersonFolder } from "@/lib/forms/closure-pinned-folder"
import { fileClosureSubmission, type ClosureFilingDeps } from "@/lib/crm-store/save-account-form"

describe("finding 2 — the safety-net retry keeps the person's closure folder", () => {
  const base = { folderId: "person-storage:6f1c2b3a-1111-4222-8333-444455556666", bucket: "closure-uploads", configKey: "closure", uploadPaths: ["a.pdf"], companyName: "X LLC" }
  it("the pinned plan read back for the retry still carries storeRootSubFolder", () => {
    const plan = pinnedPlan({ pinned_plan: { ...base, storeRootSubFolder: "Company closure_X LLC" } })
    expect(plan).toMatchObject({ folderId: base.folderId, storeRootSubFolder: "Company closure_X LLC" })
  })
  it("a plan with no person folder (a company's storage) stays without one", () => {
    expect(pinnedPlan({ pinned_plan: base })).not.toHaveProperty("storeRootSubFolder")
    expect(pinnedPlan({ pinned_plan: { ...base, storeRootSubFolder: "" } })).not.toHaveProperty("storeRootSubFolder")
    expect(pinnedPlan({ pinned_plan: { ...base, storeRootSubFolder: 42 } })).not.toHaveProperty("storeRootSubFolder")
  })
  it("a plan missing its essentials is still refused (unchanged)", () => {
    expect(pinnedPlan({ pinned_plan: { bucket: "b", configKey: "closure" } })).toBeNull()
    expect(pinnedPlan(null)).toBeNull()
  })
})

describe("finding 5 — a later staff review must not re-file a package the wizard kept with the person", () => {
  it("pinnedPersonFolder reads the folder the wizard pinned, only if it is a closure folder", () => {
    expect(pinnedPersonFolder({ pinned_plan: { storeRootSubFolder: "Company closure_X LLC" } })).toBe("Company closure_X LLC")
    expect(pinnedPersonFolder({ pinned_plan: { storeRootSubFolder: "Bank applications" } })).toBeNull()
    expect(pinnedPersonFolder({ pinned_plan: {} })).toBeNull()
    expect(pinnedPersonFolder(null)).toBeNull()
    expect(pinnedPersonFolder(undefined)).toBeNull()
  })

  const deps = (): ClosureFilingDeps => ({
    save: vi.fn(async () => { throw new Error("must not file into the company") }),
    saveForContact: vi.fn(async () => { throw new Error("must not be called") }),
    finished: vi.fn(async () => false),
    markFiled: vi.fn(async () => {}),
    alarm: vi.fn(async () => {}),
  })
  const sub = { id: "s1", token: "t1", account_id: "acc-a", contact_id: "c1", upload_paths: ["x.pdf"], completed_at: null }

  it("linked to a company but pinned to the person's folder: nothing is filed in the company, the review is allowed, and it says why", async () => {
    const d = deps()
    const r = await fileClosureSubmission({ ...sub, filedInPersonFolder: "Company closure_Italyflow LLC" }, {}, "Italyflow LLC", "test", d)
    expect(r.ok).toBe(true)
    expect(r.lines.join(" ")).toContain("Company closure_Italyflow LLC")
    expect(r.lines.join(" ")).toContain("NOT filed again in the company's storage")
    expect(d.save).not.toHaveBeenCalled()
    expect(d.saveForContact).not.toHaveBeenCalled()
  })

  it("not pinned to a person folder (both checks agreed): the review files into the company exactly as before", async () => {
    const d = deps()
    ;(d.save as ReturnType<typeof vi.fn>).mockResolvedValue({ route: "store", fileId: "f", pointer: "p", result: { summaryFileId: "store:1", copied: [], failed: [], skipped: [], errors: [] } })
    const r = await fileClosureSubmission({ ...sub, filedInPersonFolder: null }, {}, "X", "test", d)
    expect(d.save).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(true)
  })
})
