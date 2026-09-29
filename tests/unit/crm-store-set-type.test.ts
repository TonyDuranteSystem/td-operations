import { describe, it, expect } from "vitest"
import { questionFor, autoCompanyAnswer } from "@/lib/crm-store/set-type"
import { labelKey } from "@/lib/crm-store/type-names"
import { typeOfRow } from "@/lib/crm-store/drive-import"

const base = {
  ownerKind: "company", personal: false, draftNeverVisible: false, published: false, filingStatus: null as string | null, typeName: "T",
  hasPerson: false, hasCompanyAnswer: false, hasFiledAnswer: false,
  people: [{ contactId: "a", name: "Anna" }], companies: [{ ownerId: "o1", name: "Co" }], personName: "Anna",
}

describe("set type — the question asked before anything changes", () => {
  it("a personal type on a company's file asks whose it is, until answered", () => {
    expect(questionFor({ ...base, personal: true })).toEqual({ kind: "person", typeName: "T", people: base.people })
    expect(questionFor({ ...base, personal: true, hasPerson: true })).toBeNull()
  })
  it("a company type on a person's file asks which company (or keep), only when the person has a company storage", () => {
    expect(questionFor({ ...base, ownerKind: "person" })).toMatchObject({ kind: "company", personName: "Anna", clientSees: false })
    expect(questionFor({ ...base, ownerKind: "person", published: true })).toMatchObject({ kind: "company", clientSees: true })
    expect(questionFor({ ...base, ownerKind: "person", hasCompanyAnswer: true })).toBeNull()
    expect(questionFor({ ...base, ownerKind: "person", companies: [] })).toBeNull()
    expect(questionFor({ ...base, ownerKind: "person", personal: true })).toBeNull()
  })
  it("a return type on a file the client sees asks whether it is the filed copy (not when already filed or hidden)", () => {
    expect(questionFor({ ...base, draftNeverVisible: true, published: true })).toEqual({ kind: "filed", typeName: "T" })
    expect(questionFor({ ...base, draftNeverVisible: true, published: true, filingStatus: "filed" })).toBeNull()
    expect(questionFor({ ...base, draftNeverVisible: true, published: false })).toBeNull()
    expect(questionFor({ ...base, draftNeverVisible: true, published: true, hasFiledAnswer: true })).toBeNull()
  })
  it("the company page answers the company question only when nobody can be surprised", () => {
    const one = [{ ownerId: "o1" }]
    expect(autoCompanyAnswer(one, "o1", false)).toBe("o1")
    expect(autoCompanyAnswer(one, "o1", true)).toBeNull() // the client sees it → co-members would
    expect(autoCompanyAnswer([...one, { ownerId: "o2" }], "o1", false)).toBeNull() // two companies → ask
    expect(autoCompanyAnswer(one, "o2", false)).toBeNull()
    expect(autoCompanyAnswer(one, null, false)).toBeNull()
  })
  it("a plain company type on a company's file needs no answer", () => {
    expect(questionFor(base)).toBeNull()
  })
})

describe("labels — one spelling rule for types, answers and records", () => {
  it("ignores case and extra spaces", () => {
    expect(labelKey("  Lease   Agreement ")).toBe("lease agreement")
    expect(labelKey("RA Renewal Confirmation")).toBe(labelKey("ra renewal confirmation"))
  })
  it("a record's type: its type number first, else its label", () => {
    const types = new Map<string, { slug: string }>([["legacy:5", { slug: "passport" }], ["name:lease agreement", { slug: "office_lease" }]])
    expect(typeOfRow(types, { document_type_id: 5, document_type_name: "Lease Agreement" })?.slug).toBe("passport")
    expect(typeOfRow(types, { document_type_id: null, document_type_name: " lease  agreement" })?.slug).toBe("office_lease")
    expect(typeOfRow(types, { document_type_id: 99, document_type_name: "Unknown" })).toBeNull()
    expect(typeOfRow(types, null)).toBeNull()
  })
})
