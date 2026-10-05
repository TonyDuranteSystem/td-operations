import { describe, it, expect } from "vitest"
import { validatePlan, planSha, encodeItem, decodeItem, finalName, PLAN_MARK, PLAN_MAX_PART_BYTES, PlanSchema, type Plan } from "@/lib/crm-store/plan-build"

const ACCT = "838f4db1-c11f-42d1-8040-a184ccf4c0ef"
const OTHER = "248961be-39ae-43ac-98ca-50465b5d585f"
const PERSON = "e83698ba-f96c-4003-a0fb-97d212356699"
const md5 = (c: string) => c.repeat(32)
const part = (id: string, c = "a", size = 1000) => ({ driveFileId: id, md5: md5(c), size })

function basePlan(): Plan {
  return PlanSchema.parse({
    company: "Prowave LLC", accountId: ACCT,
    items: [
      { key: "1", source: part("drive-file-1"), owner: { kind: "company", accountId: ACCT, companyName: "Prowave LLC" }, folder: { kind: "company", path: [] }, name: "Articles of Organization - Prowave LLC - 2024", documentType: "articles_of_organization", year: 2024 },
      { key: "13", source: part("drive-file-13", "b"), appended: [part("drive-cert-55", "c")], owner: { kind: "company", accountId: ACCT, companyName: "Prowave LLC" }, folder: { kind: "company", path: [] }, name: "Operating Agreement - Prowave LLC - 2024", documentType: "operating_agreement", year: 2024 },
      { key: "63", source: part("drive-file-63", "d"), appended: [part("drive-cert-54", "e")], owner: { kind: "company", accountId: ACCT, companyName: "Prowave LLC" }, folder: { kind: "company", path: ["DBA"] }, name: "DBA Application Kaizen Company - Prowave LLC - 2025", documentType: null, year: 2025 },
      { key: "5", source: part("drive-file-5", "f"), owner: { kind: "company", accountId: ACCT, companyName: "Prowave LLC" }, folder: { kind: "tax", path: ["2024"] }, name: "Tax Questionnaire - Prowave LLC - 2024", documentType: null, year: 2024 },
      { key: "15", source: part("drive-file-15", "1"), owner: { kind: "person", contactId: PERSON, fullName: "Matteo Mangili" }, folder: { kind: "personal", path: [] }, name: "Passport - Matteo Mangili", documentType: "passport", year: null },
      { key: "59", source: part("drive-file-59", "2"), owner: { kind: "person", contactId: PERSON, fullName: "Matteo Mangili" }, folder: { kind: "personal", path: ["Correspondence"] }, name: "Capital One Letter - Matteo Mangili", documentType: null, year: 2026 },
      { key: "49", source: part("drive-file-49", "3"), crossCompany: true, owner: { kind: "company", accountId: OTHER, companyName: "Matteo Mangili Consulting LLC" }, folder: { kind: "tax", path: ["2025"] }, name: "Form 1099-DA Kraken - 2025", documentType: null, year: 2025 },
    ],
    leaveInDrive: ["drive-draft-7", "drive-draft-8"],
    hold: ["drive-wise-46"],
  })
}

describe("validatePlan", () => {
  it("accepts a good plan (merges, a DBA folder, a person's Correspondence folder, a cross-company item)", () => {
    const r = validatePlan(basePlan())
    expect(r.errors).toEqual([])
    expect(r.plan?.items).toHaveLength(7)
  })

  it("refuses a file listed twice (as a document and as a certificate, or also left in Drive)", () => {
    const p = basePlan()
    p.items[1].appended = [part("drive-file-1", "c")]
    expect(validatePlan(p).errors.join()).toMatch(/listed twice/)
    const q = basePlan(); q.leaveInDrive = ["drive-file-5"]
    expect(validatePlan(q).errors.join()).toMatch(/listed twice/)
  })

  it("refuses an item for another company unless it is marked on purpose", () => {
    const p = basePlan(); p.items[6].crossCompany = false
    expect(validatePlan(p).errors.join()).toMatch(/another company/)
  })

  it("refuses two items with the same name in the same folder, but allows the same name elsewhere", () => {
    const p = basePlan(); p.items[3].name = p.items[0].name; p.items[3].folder = { kind: "company", path: [] }
    expect(validatePlan(p).errors.join()).toMatch(/same name in the same folder/)
    const q = basePlan(); q.items[3].name = q.items[0].name // different folder (tax/2024) → fine
    expect(validatePlan(q).errors).toEqual([])
  })

  it("is case-insensitive about names in a folder", () => {
    const p = basePlan(); p.items[3].name = p.items[0].name.toUpperCase(); p.items[3].folder = { kind: "company", path: [] }
    expect(validatePlan(p).errors.join()).toMatch(/same name/)
  })

  it("refuses a folder kind the owner does not have", () => {
    const p = basePlan(); p.items[4].folder = { kind: "banking", path: [] }
    expect(validatePlan(p).errors.join()).toMatch(/has no "banking" folder/)
    const q = basePlan(); q.items[0].folder = { kind: "personal", path: [] }
    expect(validatePlan(q).errors.join()).toMatch(/has no "personal" folder/)
  })

  it("refuses an ID or tax number inside a file name", () => {
    const p = basePlan(); p.items[0].name = "EIN Letter 301419400 Prowave"
    expect(validatePlan(p).errors.join()).toMatch(/ID or tax number/)
    const q = basePlan(); q.items[0].name = "Letter 30-1419400"
    expect(validatePlan(q).errors.join()).toMatch(/ID or tax number/)
  })

  it("refuses slashes in names and unsafe folder names, and a missing checksum", () => {
    const p = basePlan(); p.items[0].name = "a/b"
    expect(validatePlan(p).errors.join()).toMatch(/slash/)
    expect(validatePlan({ ...basePlan(), items: [{ ...basePlan().items[0], folder: { kind: "company", path: ["../x"] } }] }).plan).toBeNull()
    expect(validatePlan({ ...basePlan(), items: [{ ...basePlan().items[0], source: { driveFileId: "drive-file-1", md5: "nope", size: 5 } }] }).plan).toBeNull()
  })

  it("refuses garbage and an empty plan", () => {
    expect(validatePlan(null).plan).toBeNull()
    expect(validatePlan({ company: "x", accountId: ACCT, items: [] }).plan).toBeNull()
  })
})

describe("planSha", () => {
  it("does not change with key order, but changes with any content change", () => {
    const a = basePlan()
    const reordered = JSON.parse(JSON.stringify(a), (_k, v) => v) as Plan
    const flipped = { items: reordered.items, hold: reordered.hold, leaveInDrive: reordered.leaveInDrive, accountId: reordered.accountId, company: reordered.company } as Plan
    expect(planSha(flipped)).toBe(planSha(a))
    const b = basePlan(); b.items[0].name = "Articles of Organization - Prowave LLC - 2025"
    expect(planSha(b)).not.toBe(planSha(a))
    const c = basePlan(); c.items[1].appended = []
    expect(planSha(c)).not.toBe(planSha(a))
  })
})

describe("ledger encoding", () => {
  it("round-trips an item through store_import_items.drive_path", () => {
    const p = basePlan()
    const sha = planSha(p)
    const enc = encodeItem(sha, p.items[1])
    expect(enc[0]).toBe(PLAN_MARK)
    const dec = decodeItem(enc)
    expect(dec?.sha).toBe(sha)
    expect(dec?.item.appended).toHaveLength(1)
    expect(dec?.item.name).toBe(p.items[1].name)
  })

  it("rejects anything that is not a plan row (an ordinary Drive path, junk)", () => {
    expect(decodeItem(["1. Company", "Sub"])).toBeNull()
    expect(decodeItem([])).toBeNull()
    expect(decodeItem(null)).toBeNull()
    expect(decodeItem([PLAN_MARK, "sha", "{not json"])).toBeNull()
    expect(decodeItem([PLAN_MARK, "sha", JSON.stringify({ key: "x" })])).toBeNull()
  })
})

describe("report of a plan-driven build", () => {
  it("shows where a plan row landed, never the raw plan text", async () => {
    const { buildReport } = await import("@/lib/crm-store/drive-import")
    const p = basePlan()
    const item = {
      id: "i1", run_id: "r", source: "drive" as const, source_id: "drive-file-1", drive_path: encodeItem(planSha(p), p.items[0]), name: p.items[0].name, mime_type: "application/pdf",
      size_bytes: 1000, source_md5: md5("a"), status: "failed" as const, reason: "boom", store_file_id: null, sha256: null, landed_in: "Prowave / 1. Company", repointed: [],
    }
    const r = buildReport([item], [])
    expect(r.failed[0].where).toBe("Prowave / 1. Company")
    expect(r.folders[0].folder).toBe("(built from the approved plan)")
    expect(JSON.stringify(r)).not.toContain('"key":"1"')
  })
})

describe("person tax folder, filing status, size and final names", () => {
  it("a person's tax papers go in the person's own tax folder (person_tax), not a company 'tax' folder", () => {
    const p = basePlan()
    p.items[4].folder = { kind: "person_tax", path: ["2024"] }
    expect(validatePlan(p).errors).toEqual([])
    const q = basePlan(); q.items[4].folder = { kind: "tax", path: ["2024"] }
    expect(validatePlan(q).errors.join()).toMatch(/has no "tax" folder/)
  })

  it("carries an optional filing status without changing the fingerprint of plans that do not use it", () => {
    const a = basePlan()
    const b = basePlan(); b.items[0].filingStatus = "filed"
    expect(planSha(b)).not.toBe(planSha(a))
    expect(PlanSchema.safeParse({ ...a, items: [{ ...a.items[0], filingStatus: "wrong" }] }).success).toBe(false)
  })

  it("refuses a document (with its certificates) over the store's per-file limit", () => {
    const p = basePlan()
    p.items[1].source.size = PLAN_MAX_PART_BYTES
    p.items[1].appended[0].size = 1000
    expect(validatePlan(p).errors.join()).toMatch(/together are over/)
    const q = basePlan(); q.items[0].source.size = PLAN_MAX_PART_BYTES + 1
    expect(validatePlan(q).plan).toBeNull()
  })

  it("finalName adds the file's extension once, and a merged document is always a PDF", () => {
    expect(finalName("Annual Report - X - 2025", "annual report.PDF", false)).toBe("Annual Report - X - 2025.pdf")
    expect(finalName("Annual Report - X - 2025.pdf", "a.pdf", false)).toBe("Annual Report - X - 2025.pdf")
    expect(finalName("Export - X", "statement.csv", false)).toBe("Export - X.csv")
    expect(finalName("Operating Agreement - X", "scan.jpg", true)).toBe("Operating Agreement - X.pdf")
    expect(finalName("No extension", "noext", false)).toBe("No extension")
    expect(finalName("No drive name", undefined, false)).toBe("No drive name")
  })
})

describe("a Drive folder shared with another account", () => {
  const twin = { id: "11111111-1111-4111-8111-111111111111", name: "Conversion Monster Llc", status: "Cancelled", documents: 0, members: 0, openDeliveries: 0 }
  it("blocks when nobody has acknowledged the other account", async () => {
    const { sharedFolderProblems } = await import("@/lib/crm-store/plan-build")
    expect(sharedFolderProblems([twin], [], 0).join()).toMatch(/shared with another account/)
    expect(sharedFolderProblems([], [], 0)).toEqual([])
  })
  it("allows an acknowledged, empty, cancelled (or closed) duplicate", async () => {
    const { sharedFolderProblems } = await import("@/lib/crm-store/plan-build")
    expect(sharedFolderProblems([twin], [twin.id], 0)).toEqual([])
    expect(sharedFolderProblems([{ ...twin, status: "Closed" }], [twin.id], 0)).toEqual([])
  })
  it("still blocks an acknowledged account that is active, has documents, members or open services", async () => {
    const { sharedFolderProblems } = await import("@/lib/crm-store/plan-build")
    expect(sharedFolderProblems([{ ...twin, status: "Active" }], [twin.id], 0).join()).toMatch(/not a cancelled or closed/)
    expect(sharedFolderProblems([{ ...twin, documents: 3 }], [twin.id], 0).join()).toMatch(/3 document/)
    expect(sharedFolderProblems([{ ...twin, members: 1 }], [twin.id], 0).join()).toMatch(/1 member/)
    expect(sharedFolderProblems([{ ...twin, openDeliveries: 2 }], [twin.id], 0).join()).toMatch(/2 open service/)
  })
  it("never lets a contact's folder through, and refuses a named account that does not share the folder", async () => {
    const { sharedFolderProblems } = await import("@/lib/crm-store/plan-build")
    expect(sharedFolderProblems([], [], 1).join()).toMatch(/contact's folder/)
    expect(sharedFolderProblems([twin], ["22222222-2222-4222-8222-222222222222", twin.id], 0).join()).toMatch(/does not\./)
  })
  it("a plan that does not use the field keeps the same fingerprint", () => {
    const a = basePlan()
    const withField = PlanSchema.parse({ ...a, sharedFolderWith: ["11111111-1111-4111-8111-111111111111"] })
    expect(planSha(withField)).not.toBe(planSha(a))
    expect(JSON.stringify(a)).not.toContain("sharedFolderWith")
  })
})
