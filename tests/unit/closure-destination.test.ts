import { describe, it, expect, vi, beforeEach } from "vitest"

// resolveClosureDestination reads the person's companies and asks resolveClosureFolder where each lands; both are faked here.
const PERSON_UUID = "6f1c2b3a-1111-4222-8333-444455556666"
const ACC_UUID = "7a2d3c4b-2222-4333-8444-555566667777"
const state = vi.hoisted(() => ({
  links: [] as Array<{ account_id: string }>,
  accounts: [] as Array<{ id: string; company_name: string | null; ein_number: string | null }>,
  err: null as string | null,
  folderCalls: [] as Array<{ accountId: string | null }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: async () => (state.err ? { data: null, error: { message: state.err } } : { data: table === "account_contacts" ? state.links : [], error: null }),
        in: async () => (state.err ? { data: null, error: { message: state.err } } : { data: state.accounts, error: null }),
      }),
    }),
  },
}))
vi.mock("@/lib/forms/closure-folder", () => ({
  resolveClosureFolder: vi.fn(async (p: { accountId: string | null }) => {
    state.folderCalls.push({ accountId: p.accountId })
    return p.accountId ? `account-storage:${ACC_UUID}` : `person-storage:${PERSON_UUID}`
  }),
}))

import {
  digitsOnly, normalizeCompanyName, matchTypedCompany, decideClosureTarget, closureFolderName, disagreementText, keepFirstFolderName, resolveClosureDestination,
} from "@/lib/forms/closure-destination"

const A = { id: "acc-a", company_name: "Datavora LLC", ein_number: "12-3456789" }
const B = { id: "acc-b", company_name: "AC Digital LLC", ein_number: "98-7654321" }

describe("digitsOnly / normalizeCompanyName", () => {
  it("an EIN is compared as digits however it was typed", () => {
    expect(digitsOnly("12-3456789")).toBe("123456789")
    expect(digitsOnly(" 12 3456789 ")).toBe("123456789")
    expect(digitsOnly(null)).toBe("")
  })
  it("a company name ignores case, accents, punctuation and the legal-form word", () => {
    expect(normalizeCompanyName("Datavora, L.L.C.")).toBe("datavora")
    expect(normalizeCompanyName("DATAVORA llc")).toBe("datavora")
    expect(normalizeCompanyName("Café  Rosé Inc.")).toBe("cafe rose")
    expect(normalizeCompanyName("")).toBe("")
    expect(normalizeCompanyName("LLC")).toBe("")
  })
  it("'Company' and 'Co' are kept — they can be the real name", () => {
    expect(normalizeCompanyName("Acme Company LLC")).toBe("acme company")
  })
})

describe("matchTypedCompany — what the client wrote against the person's companies", () => {
  it("the EIN (exact digits) matches one company", () => {
    expect(matchTypedCompany({ name: "whatever", ein: "12 3456789" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "ein" })
  })
  it("the EIN wins over a spelling of the name that matches no company (a different spelling of the same company)", () => {
    expect(matchTypedCompany({ name: "Wholly Different Spelling Inc", ein: "123456789" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "ein" })
  })
  it("…but NOT when the name is, word for word, ANOTHER of the person's companies (half of the pre-filled pair was changed) — ambiguous, never a pick (bug hunt 2026-11-06)", () => {
    expect(matchTypedCompany({ name: "AC Digital", ein: "123456789" }, [A, B])).toEqual({ status: "ambiguous", ids: ["acc-a", "acc-b"] })
  })
  it("the EIN and the name pointing at the SAME company stay one clean match", () => {
    expect(matchTypedCompany({ name: "Datavora LLC", ein: "12-3456789" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "ein" })
  })
  it("with no usable EIN, the name matches (legal-form word and punctuation ignored)", () => {
    expect(matchTypedCompany({ name: "datavora, l.l.c.", ein: "" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "name" })
    expect(matchTypedCompany({ name: "Datavora", ein: "12345" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "name" }) // a short EIN counts for nothing
  })
  it("Ranieri / Covelli: another company's name and EIN match none of the person's companies", () => {
    expect(matchTypedCompany({ name: "Italyflow LLC", ein: "55-1234567" }, [B])).toEqual({ status: "none" })
    expect(matchTypedCompany({ name: "Doctor Veg LLC", ein: "66-7654321" }, [{ id: "d", company_name: "DoctorGut LLC", ein_number: "11-1111111" }])).toEqual({ status: "none" })
  })
  it("two companies with the same EIN or the same name are ambiguous — never a pick", () => {
    expect(matchTypedCompany({ ein: "123456789" }, [A, { ...B, ein_number: "123456789" }])).toEqual({ status: "ambiguous", ids: ["acc-a", "acc-b"] })
    expect(matchTypedCompany({ name: "Datavora" }, [A, { ...B, company_name: "Datavora Inc" }])).toEqual({ status: "ambiguous", ids: ["acc-a", "acc-b"] })
  })
  it("a company with no EIN stored is matched by name only; nothing typed matches nothing", () => {
    expect(matchTypedCompany({ name: "Datavora LLC", ein: "123456789" }, [{ ...A, ein_number: null }])).toEqual({ status: "one", id: "acc-a", by: "name" })
    expect(matchTypedCompany({}, [A, B])).toEqual({ status: "none" })
    expect(matchTypedCompany({ name: "LLC" }, [A, B])).toEqual({ status: "none" })
  })
})

describe("decideClosureTarget — only 'both agree' reaches a company's storage", () => {
  it("linked + the wizard names that company → the company", () => {
    expect(decideClosureTarget({ linkedAccountId: "acc-a", match: { status: "one", id: "acc-a", by: "ein" } })).toEqual({ kind: "company", accountId: "acc-a" })
  })
  it("not linked + the wizard names none of ours → another company, nothing to check", () => {
    expect(decideClosureTarget({ linkedAccountId: null, match: { status: "none" } })).toEqual({ kind: "other_company", disagreement: null })
  })
  it("every disagreement goes to the person's folder with a reason", () => {
    expect(decideClosureTarget({ linkedAccountId: "acc-a", match: { status: "none" } })).toEqual({ kind: "other_company", disagreement: "linked_no_match" })
    expect(decideClosureTarget({ linkedAccountId: "acc-a", match: { status: "one", id: "acc-b", by: "name" } })).toEqual({ kind: "other_company", disagreement: "linked_other" })
    expect(decideClosureTarget({ linkedAccountId: null, match: { status: "one", id: "acc-a", by: "ein" } })).toEqual({ kind: "other_company", disagreement: "match_not_linked" })
    expect(decideClosureTarget({ linkedAccountId: "acc-a", match: { status: "ambiguous", ids: ["x", "y"] } })).toEqual({ kind: "other_company", disagreement: "ambiguous" })
    expect(decideClosureTarget({ linkedAccountId: null, match: { status: "ambiguous", ids: ["x", "y"] } })).toEqual({ kind: "other_company", disagreement: "ambiguous" })
  })
})

describe("closureFolderName / disagreementText", () => {
  it("the folder is 'Company closure_<name>'", () => {
    expect(closureFolderName("Italyflow LLC")).toBe("Company closure_Italyflow LLC")
    expect(closureFolderName("  Doctor Veg LLC ")).toBe("Company closure_Doctor Veg LLC")
    expect(closureFolderName("")).toBe("Company closure_Unknown LLC")
    expect(closureFolderName(undefined)).toBe("Company closure_Unknown LLC")
  })
  it("each disagreement says what to check, in plain words, and names the folder used", () => {
    const names = { typed: "Italyflow LLC", linked: "Datavora LLC", matched: "AC Digital LLC" }
    for (const d of ["linked_no_match", "linked_other", "match_not_linked", "ambiguous"] as const) {
      const t = disagreementText(d, names)
      expect(t).toContain("Company closure_Italyflow LLC")
      expect(t).toMatch(/check/i)
    }
    expect(disagreementText("linked_no_match", names)).toContain("Datavora LLC")
    expect(disagreementText("match_not_linked", names)).toContain("AC Digital LLC")
  })
})

describe("disagreementText — never says 'X, which is X' (QA 2026-11-06)", () => {
  it("not linked but the client wrote the company's own name: no repeated name", () => {
    const t = disagreementText("match_not_linked", { typed: "ZZ Browser QA LLC 861626", linked: null, matched: "ZZ Browser QA LLC 861626" })
    expect(t).not.toContain("which is ZZ Browser QA LLC 861626")
    expect(t).toContain('The client wrote "ZZ Browser QA LLC 861626", one of our companies, but this closure is not linked to it')
  })
  it("a spelling that differs only by the legal-form word or punctuation counts as the same name", () => {
    const t = disagreementText("match_not_linked", { typed: "Datavora, L.L.C.", linked: null, matched: "Datavora LLC" })
    expect(t).toContain("one of our companies")
  })
  it("a really different matched name is still named (so staff see which company it is)", () => {
    const t = disagreementText("match_not_linked", { typed: "Alpha Beta", linked: null, matched: "AC Digital LLC" })
    expect(t).toContain("which is AC Digital LLC")
    const o = disagreementText("linked_other", { typed: "Alpha Beta", linked: "Datavora LLC", matched: "AC Digital LLC" })
    expect(o).toContain("which is AC Digital LLC")
    expect(o).toContain("Datavora LLC")
  })
  it("linked but the client wrote another of the person's companies under its own name: no repeat either", () => {
    const o = disagreementText("linked_other", { typed: "AC Digital LLC", linked: "Datavora LLC", matched: "AC Digital LLC" })
    expect(o).not.toContain("which is AC Digital LLC")
    expect(o).toContain("one of the person's other companies")
  })
})

describe("closureFolderName — only names the store accepts (bug hunt finding 3)", () => {
  it('"/" and "\\" become "-" — "24/7 Rentals LLC" can be filed (the store refuses a slash in a folder name and the whole filing aborted)', () => {
    expect(closureFolderName("24/7 Rentals LLC")).toBe("Company closure_24-7 Rentals LLC")
    expect(closureFolderName("A\\B Trading")).toBe("Company closure_A-B Trading")
  })
  it("control characters become '-' and runs of spaces collapse", () => {
    expect(closureFolderName("Bad\u0000Name\tLLC  X")).toBe("Company closure_Bad-Name-LLC X")
  })
  it("never longer than the store allows (255), and no trailing space is left", () => {
    const n = closureFolderName("X".repeat(400))
    expect(n.length).toBeLessThanOrEqual(255)
    expect(n.startsWith("Company closure_X")).toBe(true)
    expect(closureFolderName("Y".repeat(239) + " " + "Z".repeat(10)).endsWith(" ")).toBe(false)
  })
  it("the cleaned name is accepted by the store's own rule", async () => {
    const { cleanFolderName } = await import("@/lib/crm-store/names")
    for (const raw of ["24/7 Rentals LLC", "A\\B", "X".repeat(400), "Bad\u0007Name", "  ", ""]) {
      expect(() => cleanFolderName(closureFolderName(raw))).not.toThrow()
    }
  })
})

describe("keepFirstFolderName — a correction keeps the folder the package already sits in", () => {
  it("the folder the first pass pinned wins over the corrected name", () => {
    expect(keepFirstFolderName("Company closure_Old Typo LLC", "Company closure_New Name LLC")).toBe("Company closure_Old Typo LLC")
  })
  it("no earlier folder: the new name stands", () => {
    expect(keepFirstFolderName(undefined, "Company closure_New LLC")).toBe("Company closure_New LLC")
    expect(keepFirstFolderName(null, "Company closure_New LLC")).toBe("Company closure_New LLC")
  })
  it("a company's storage has no sub-folder: nothing is invented", () => {
    expect(keepFirstFolderName("Company closure_Old LLC", undefined)).toBeUndefined()
  })
  it("a pinned value that is not a closure folder name is ignored", () => {
    expect(keepFirstFolderName("Bank applications", "Company closure_New LLC")).toBe("Company closure_New LLC")
    expect(keepFirstFolderName(42, "Company closure_New LLC")).toBe("Company closure_New LLC")
  })
})

describe("resolveClosureDestination", () => {
  beforeEach(() => { state.links = []; state.accounts = []; state.err = null; state.folderCalls = [] })

  it("another company (Ranieri): the person's storage, folder Company closure_<name>, nothing to check", async () => {
    state.links = [{ account_id: "acc-b" }]; state.accounts = [B]
    const d = await resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "Christian", submittedData: { llc_name: "Italyflow LLC", llc_ein: "55-1234567" } })
    expect(d).toEqual({ folderId: `person-storage:${PERSON_UUID}`, storeRootSubFolder: "Company closure_Italyflow LLC", kind: "other_company", disagreement: null, storageOwnerId: PERSON_UUID })
    expect(state.folderCalls).toEqual([{ accountId: null }])
  })
  it("the client's own company, job linked and the wizard agrees: that company's storage, no sub-folder", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d).toEqual({ folderId: `account-storage:${ACC_UUID}`, kind: "company", disagreement: null, storageOwnerId: "acc-a" })
    expect(d.storeRootSubFolder).toBeUndefined()
  })
  it("a company that kept its Drive folder id (262 of 275 on production): the files still belong to the COMPANY's storage — the owner is the company, not the Drive id (bug hunt finding 4)", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const folder = await import("@/lib/forms/closure-folder")
    vi.mocked(folder.resolveClosureFolder).mockResolvedValueOnce("1AbCdEfDriveFolderId")
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d).toEqual({ folderId: "1AbCdEfDriveFolderId", kind: "company", disagreement: null, storageOwnerId: "acc-a" })
  })
  it("the client's own company that has NO storage yet: the person's tidy 'Company closure_<name>' folder, nothing to check", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const folder = await import("@/lib/forms/closure-folder")
    vi.mocked(folder.resolveClosureFolder).mockResolvedValueOnce(`person-storage:${PERSON_UUID}`)
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d).toEqual({ folderId: `person-storage:${PERSON_UUID}`, storeRootSubFolder: "Company closure_Datavora LLC", kind: "company", disagreement: null, storageOwnerId: PERSON_UUID })
  })
  it("the job's linked company is a candidate even when the person is not in account_contacts", async () => {
    state.links = []; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d.kind).toBe("company")
  })
  it("linked but the wizard wrote something else: the person's folder AND a line for staff — never the company's storage", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Italyflow LLC", llc_ein: "55-1234567" } })
    expect(d.kind).toBe("other_company")
    expect(d.folderId).toBe(`person-storage:${PERSON_UUID}`)
    expect(d.storeRootSubFolder).toBe("Company closure_Italyflow LLC")
    expect(d.storageOwnerId).toBe(PERSON_UUID)
    expect(d.disagreement).toContain("Datavora LLC")
    expect(state.folderCalls).toEqual([{ accountId: null }])
  })
  it("not linked but the wizard wrote one of the person's own companies: the person's folder AND a line for staff", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora", llc_ein: "123456789" } })
    expect(d.kind).toBe("other_company")
    expect(d.disagreement).toContain("one of our companies")
    expect(d.disagreement).toContain("not linked")
  })
  it("a person with no companies at all and no link: another company", async () => {
    const d = await resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Milan Co LLC", llc_ein: "" } })
    expect(d.kind).toBe("other_company")
    expect(d.disagreement).toBeNull()
  })
  it("a read error THROWS (the caller retries) and nothing is decided", async () => {
    state.err = "db down"
    await expect(resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "C", submittedData: {} })).rejects.toThrow(/retryable/)
    expect(state.folderCalls).toEqual([])
  })
})
