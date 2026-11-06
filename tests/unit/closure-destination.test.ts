import { describe, it, expect, vi, beforeEach } from "vitest"

// resolveClosureDestination reads the person's companies and asks resolveClosureFolder where each lands; both are faked here.
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
    return p.accountId ? `account-storage:${p.accountId}` : "person-storage:contact-1"
  }),
}))

import {
  digitsOnly, normalizeCompanyName, matchTypedCompany, decideClosureTarget, closureFolderName, disagreementText, resolveClosureDestination,
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
  it("the EIN wins over a name that points elsewhere", () => {
    expect(matchTypedCompany({ name: "AC Digital", ein: "123456789" }, [A, B])).toEqual({ status: "one", id: "acc-a", by: "ein" })
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

describe("resolveClosureDestination", () => {
  beforeEach(() => { state.links = []; state.accounts = []; state.err = null; state.folderCalls = [] })

  it("another company (Ranieri): the person's storage, folder Company closure_<name>, nothing to check", async () => {
    state.links = [{ account_id: "acc-b" }]; state.accounts = [B]
    const d = await resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "Christian", submittedData: { llc_name: "Italyflow LLC", llc_ein: "55-1234567" } })
    expect(d).toEqual({ folderId: "person-storage:contact-1", storeRootSubFolder: "Company closure_Italyflow LLC", kind: "other_company", disagreement: null })
    expect(state.folderCalls).toEqual([{ accountId: null }])
  })
  it("the client's own company, job linked and the wizard agrees: that company's storage, no sub-folder", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d).toEqual({ folderId: "account-storage:acc-a", kind: "company", disagreement: null })
    expect(d.storeRootSubFolder).toBeUndefined()
  })
  it("the client's own company that has NO storage yet: the person's tidy 'Company closure_<name>' folder, nothing to check", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const folder = await import("@/lib/forms/closure-folder")
    vi.mocked(folder.resolveClosureFolder).mockResolvedValueOnce("person-storage:contact-1")
    const d = await resolveClosureDestination({ linkedAccountId: "acc-a", contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora LLC", llc_ein: "12-3456789" } })
    expect(d).toEqual({ folderId: "person-storage:contact-1", storeRootSubFolder: "Company closure_Datavora LLC", kind: "company", disagreement: null })
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
    expect(d.folderId).toBe("person-storage:contact-1")
    expect(d.storeRootSubFolder).toBe("Company closure_Italyflow LLC")
    expect(d.disagreement).toContain("Datavora LLC")
    expect(state.folderCalls).toEqual([{ accountId: null }])
  })
  it("not linked but the wizard wrote one of the person's own companies: the person's folder AND a line for staff", async () => {
    state.links = [{ account_id: "acc-a" }]; state.accounts = [A]
    const d = await resolveClosureDestination({ linkedAccountId: null, contactId: "contact-1", clientName: "C", submittedData: { llc_name: "Datavora", llc_ein: "123456789" } })
    expect(d.kind).toBe("other_company")
    expect(d.disagreement).toContain("Datavora LLC")
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
