import { describe, it, expect, vi } from "vitest"
import { folderKindForDriveSubfolder, saveFormToStore, splitStorePath, type FormStoreDeps, type FormStoreSpec } from "@/lib/crm-store/save-form"

const account = { kind: "account" as const, id: "acc-1", ownerId: "owner-1" }
const contact = { kind: "contact" as const, id: "c-1", ownerId: "person-1" }

describe("folderKindForDriveSubfolder — the storage folder that matches the Drive sub-folder", () => {
  it("maps the numbered company folders", () => {
    expect(folderKindForDriveSubfolder("1. Company", account)).toBe("company")
    expect(folderKindForDriveSubfolder("3. Tax", account)).toBe("tax")
    expect(folderKindForDriveSubfolder("4. Banking", account)).toBe("banking")
    expect(folderKindForDriveSubfolder("5. Correspondence", account)).toBe("correspondence")
  })
  it("ITIN filed under a company goes to the company folder; a person's ITIN goes to their ITIN folder; other person forms stay in Personal documents", () => {
    expect(folderKindForDriveSubfolder("ITIN", account)).toBe("company")
    expect(folderKindForDriveSubfolder("ITIN", contact)).toBe("itin")
    expect(folderKindForDriveSubfolder("3. Tax", contact)).toBe("personal")
  })
})

describe("splitStorePath — a workflow's sub-folder path in a company's storage", () => {
  it("numbered top folders map to their storage folders; the rest of the path is nested folders", () => {
    expect(splitStorePath("3. Tax/2025")).toEqual({ topKind: "tax", segments: ["2025"] })
    expect(splitStorePath("4. Banking")).toEqual({ topKind: "banking", segments: [] })
    expect(splitStorePath("5. Correspondence/IRS")).toEqual({ topKind: "correspondence", segments: ["IRS"] })
    expect(splitStorePath("1. Company/Leases/2026")).toEqual({ topKind: "company", segments: ["Leases", "2026"] })
  })
  it("any other path (the usual 'Workflow Uploads', 'ITIN/IRS Letters') goes under the company folder", () => {
    expect(splitStorePath("Workflow Uploads")).toEqual({ topKind: "company", segments: ["Workflow Uploads"] })
    expect(splitStorePath("ITIN/IRS Letters")).toEqual({ topKind: "company", segments: ["ITIN", "IRS Letters"] })
  })
  it("'2. Contacts' is each person's own storage — not a place to file, so it falls back to the company folder", () => {
    expect(splitStorePath("2. Contacts/Passports")).toEqual({ topKind: "company", segments: ["Passports"] })
  })
  it("ignores blanks, extra slashes and spaces", () => {
    expect(splitStorePath(" / 3. Tax / /2025/ ")).toEqual({ topKind: "tax", segments: ["2025"] })
    expect(splitStorePath("")).toEqual({ topKind: "company", segments: [] })
  })
})

const mk = (over: Partial<FormStoreDeps> = {}) => {
  const saved: Array<Record<string, unknown>> = []
  const deps: FormStoreDeps = {
    saveFile: vi.fn(async (p) => { saved.push(p); return { status: "created", fileId: `0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f${saved.length}` } as never }),
    download: vi.fn(async () => ({ bytes: Buffer.from("x"), mimeType: "application/pdf" })),
    yearFolder: vi.fn(async (_t, y) => `year-${y}`),
    taxFolder: vi.fn(async () => "tax-folder"),
    ...over,
  }
  return { deps, saved }
}
const base = (over: Partial<FormStoreSpec> = {}): FormStoreSpec => ({
  target: account, subfolder: "1. Company", year: null,
  summary: { name: "Onboarding_Data_Acme.pdf", bytes: Buffer.from("pdf"), documentType: null, callerKey: "form-summary:acc-1:onboarding:T1" },
  uploadPaths: ["acme/passport.pdf", "acme/ein.pdf"], bucketOf: () => "onboarding-uploads", submissionKey: "acc-1:onboarding:T1", ...over,
})

describe("saveFormToStore — a switched company's form summary and uploads", () => {
  it("saves the summary and every upload into the matching top folder, never into Drive", async () => {
    const { deps, saved } = mk()
    const r = await saveFormToStore(base(), deps)
    expect(r.summaryFileId).toBe("store:0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f1") // a POINTER, never a raw store id
    expect(r.copied).toEqual(["passport.pdf", "ein.pdf"])
    expect(r.failed).toEqual([])
    expect(saved.map((s) => s.folderKind)).toEqual(["company", "company", "company"])
    expect(saved[0]).toMatchObject({ ownerId: "owner-1", name: "Onboarding_Data_Acme.pdf", callerKey: "form-summary:acc-1:onboarding:T1" })
    expect(saved[1]).toMatchObject({ callerKey: "form-upload:acc-1:onboarding:T1:acme/passport.pdf", documentType: null })
  })

  it("the Formation Summary keeps its staff-only type", async () => {
    const { deps, saved } = mk()
    await saveFormToStore(base({ summary: { name: "Formation_Data_X.pdf", bytes: Buffer.from("p"), documentType: "formation_summary", callerKey: "k" }, uploadPaths: [] }), deps)
    expect(saved[0]).toMatchObject({ documentType: "formation_summary" })
  })

  it("a tax return goes into its year folder (found or created) inside 3. Tax", async () => {
    const { deps, saved } = mk()
    await saveFormToStore(base({ subfolder: "3. Tax", year: 2025, uploadPaths: [] }), deps)
    expect(deps.taxFolder).toHaveBeenCalledWith("owner-1")
    expect(deps.yearFolder).toHaveBeenCalledWith("tax-folder", "2025")
    expect(saved[0]).toMatchObject({ folderKind: "tax", folderId: "year-2025" })
  })

  it("an unresolved year folder ABORTS: nothing is filed in the top folder", async () => {
    const { deps, saved } = mk({ yearFolder: async () => { throw new Error("boom") } })
    const r = await saveFormToStore(base({ subfolder: "3. Tax", year: 2025 }), deps)
    expect(saved).toHaveLength(0)
    expect(r.summaryFileId).toBeNull()
    expect(r.errors[0]).toMatch(/aborted to avoid misfiling/)
  })

  it("an identical re-run counts as skipped (a new version of the same file, never a copy)", async () => {
    const { deps } = mk({ saveFile: async () => ({ status: "unchanged", fileId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" }) as never })
    const r = await saveFormToStore(base(), deps)
    expect(r.skipped).toEqual(["passport.pdf", "ein.pdf"])
    expect(r.copied).toEqual([])
  })

  it("an upload that cannot be downloaded or saved is reported, the others still go in", async () => {
    const { deps } = mk({ download: async (_bucket, path) => (path.includes("one") ? null : { bytes: Buffer.from("x"), mimeType: null }) })
    vi.useFakeTimers()
    const p = saveFormToStore(base({ uploadPaths: ["a/one.pdf", "a/two.pdf"] }), deps)
    await vi.runAllTimersAsync()
    const r = await p
    vi.useRealTimers()
    expect(r.failed[0]).toMatch(/one\.pdf \(download failed/)
    expect(r.copied).toEqual(["two.pdf"])
  })

  it("a failing summary save is reported as an error, the uploads still go in", async () => {
    let first = true
    const { deps } = mk({ saveFile: async () => { if (first) { first = false; throw new Error("store down") } return { status: "created", fileId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" } as never } })
    const r = await saveFormToStore(base(), deps)
    expect(r.errors[0]).toMatch(/Summary PDF error: store down/)
    expect(r.copied).toHaveLength(2)
  })

  it("a person's ITIN form goes into their ITIN folder; any other person form into Personal documents", async () => {
    const a = mk()
    await saveFormToStore(base({ target: contact, subfolder: "ITIN", uploadPaths: [] }), a.deps)
    expect(a.saved[0]).toMatchObject({ ownerId: "person-1", folderKind: "itin" })
    const b = mk()
    await saveFormToStore(base({ target: contact, subfolder: "3. Tax", uploadPaths: [] }), b.deps)
    expect(b.saved[0]).toMatchObject({ ownerId: "person-1", folderKind: "personal" })
  })
})

describe("saveFormToStore — a person's ITIN form goes to the ITIN folder", () => {
  const person = { kind: "contact", id: "c-1", ownerId: "owner-p" } as never
  it("summary and uploads go to the itin folder", async () => {
    const { deps, saved } = mk()
    await saveFormToStore(base({ target: person, subfolder: "ITIN", uploadPaths: ["a/passport.pdf"], summary: { name: "ITIN_Data_X.pdf", bytes: Buffer.from("p"), documentType: "itin_application", callerKey: "k" } }), deps)
    expect(saved.map((x) => x.folderKind)).toEqual(["itin", "itin"])
    expect(saved[0]).toMatchObject({ documentType: "itin_application" })
  })
  it("a person storage with no ITIN folder falls back to Personal documents instead of failing", async () => {
    const calls: string[] = []
    const deps = mk({ saveFile: vi.fn(async (p) => { calls.push(p.folderKind); if (p.folderKind === "itin") throw new Error('store pilot: owner owner-p has no "itin" folder'); return { status: "created", fileId: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f1" } as never }) }).deps
    const r = await saveFormToStore(base({ target: person, subfolder: "ITIN", uploadPaths: [], summary: { name: "ITIN_Data_X.pdf", bytes: Buffer.from("p"), documentType: null, callerKey: "k" } }), deps)
    expect(calls).toEqual(["itin", "personal"])
    expect(r.errors).toEqual([])
  })
})
