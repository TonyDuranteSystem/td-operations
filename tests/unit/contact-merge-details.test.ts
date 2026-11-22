import { describe, it, expect } from "vitest"
import {
  isEmptyValue, normalizeForCompare, diffPersonalDetails, unresolvedIdentityConflicts, cleanChoices,
  suggestKeep, followsCopies, countFilledDetails, eligibleOwnerlessDocs, cleanDocumentIds, DETAIL_FIELDS, IDENTITY_DETAIL_FIELDS,
} from "@/lib/contacts/merge-details"

describe("isEmptyValue", () => {
  it("treats null, undefined, '' and whitespace as empty", () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue("")).toBe(true)
    expect(isEmptyValue("   \t")).toBe(true)
  })
  it("keeps real values, including 0 and false", () => {
    expect(isEmptyValue("a")).toBe(false)
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
  })
})

describe("normalizeForCompare", () => {
  it("ignores case, spaces and punctuation", () => {
    expect(normalizeForCompare(" 123-45 6789 ")).toBe(normalizeForCompare("123456789"))
    expect(normalizeForCompare("X1234567")).toBe(normalizeForCompare("x 1234-567"))
    expect(normalizeForCompare("+1 (555) 0114")).toBe("15550114")
  })
  it("keeps letters from other alphabets", () => {
    expect(normalizeForCompare("Müller")).toBe("müller")
  })
})

describe("diffPersonalDetails", () => {
  it("copies when the kept value is empty in any empty form", () => {
    const rows = diffPersonalDetails({ passport_number: "", phone: "   ", itin_number: null }, { passport_number: "P123", phone: "+1 555", itin_number: "9XX" })
    expect(rows.map((r) => [r.field, r.status])).toEqual([["passport_number", "copy"], ["itin_number", "copy"], ["phone", "copy"]])
  })
  it("flags a conflict only when the values really differ", () => {
    const rows = diffPersonalDetails({ passport_number: "AB-123", phone: "+1 555 0114" }, { passport_number: "ab123", phone: "+1 555 0199" })
    expect(rows.find((r) => r.field === "passport_number")?.status).toBe("same")
    expect(rows.find((r) => r.field === "phone")?.status).toBe("conflict")
  })
  it("marks identity fields and reports kept-only values", () => {
    const rows = diffPersonalDetails({ date_of_birth: "1990-09-19", gender: "F" }, { date_of_birth: "1991-01-01", gender: null })
    expect(rows.find((r) => r.field === "date_of_birth")).toMatchObject({ identity: true, status: "conflict" })
    expect(rows.find((r) => r.field === "gender")).toMatchObject({ identity: false, status: "only_kept" })
  })
  it("skips details both contacts lack and never lists portal_tier or passport_on_file", () => {
    const rows = diffPersonalDetails({ portal_tier: "active", passport_on_file: true }, { portal_tier: "lead", passport_on_file: false })
    expect(rows).toEqual([])
    expect(DETAIL_FIELDS).not.toContain("portal_tier")
    expect(DETAIL_FIELDS).not.toContain("passport_on_file")
    expect(DETAIL_FIELDS).not.toContain("email")
  })
  it("has all identity details inside the list", () => {
    for (const f of IDENTITY_DETAIL_FIELDS) expect(DETAIL_FIELDS).toContain(f)
  })
})

describe("address block, dependent dates, odd values", () => {
  it("treats the address as one row, never a mix", () => {
    const rows = diffPersonalDetails({ address_city: "Miami" }, { address_line1: "10 Via Roma", address_city: "Rome", address_country: "IT" })
    const a = rows.filter((r) => r.field.startsWith("address"))
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ field: "address_line1", status: "conflict", kept: "Miami" })
  })
  it("copies the whole address only when the kept one is empty", () => {
    const rows = diffPersonalDetails({}, { address_line1: "10 Via Roma", address_city: "Rome" })
    expect(rows[0]).toMatchObject({ field: "address_line1", status: "copy", removed: "10 Via Roma, Rome" })
  })
  it("marks the dates that belong to a passport / ITIN number", () => {
    const rows = diffPersonalDetails({ passport_number: "X1" }, { passport_number: "Y2", passport_expiry_date: "2031-01-01", itin_issue_date: "2022-06-02" })
    expect(rows.find((r) => r.field === "passport_expiry_date")).toMatchObject({ status: "follows", dependsOn: "passport_number" })
    expect(rows.find((r) => r.field === "itin_issue_date")?.dependsOn).toBe("itin_number")
  })
  it("two values made only of punctuation are not the same, and tabs count as empty", () => {
    expect(diffPersonalDetails({ phone: "-" }, { phone: "." })[0].status).toBe("conflict")
    expect(diffPersonalDetails({ phone: "\t\n" }, { phone: "+1" })[0].status).toBe("copy")
  })
})

describe("dates that follow their number", () => {
  const rows = diffPersonalDetails({ passport_number: "X1", passport_expiry_date: "2030-01-01" }, { passport_number: "Y2", passport_expiry_date: "2031-01-01" })
  it("are never a choice of their own", () => {
    expect(rows.find((r) => r.field === "passport_expiry_date")?.status).toBe("follows")
    expect(unresolvedIdentityConflicts(rows, {}).map((r) => r.field)).toEqual(["passport_number"])
    expect(cleanChoices(rows, { passport_expiry_date: "loser", passport_number: "loser" })).toEqual({ passport_number: "loser" })
  })
  it("are copied exactly when their number is taken from the removed contact", () => {
    expect(followsCopies(rows, "passport_expiry_date", { passport_number: "loser" })).toBe(true)
    expect(followsCopies(rows, "passport_expiry_date", { passport_number: "winner" })).toBe(false)
    expect(followsCopies(rows, "passport_expiry_date", {})).toBe(false)
  })
  it("same number: a missing kept date is copied, a different kept date stays", () => {
    const r1 = diffPersonalDetails({ itin_number: "9XX" }, { itin_number: "9-XX", itin_issue_date: "2022-06-02" })
    expect(r1.find((r) => r.field === "itin_issue_date")?.status).toBe("follows")
    expect(followsCopies(r1, "itin_issue_date", {})).toBe(true)
    const r2 = diffPersonalDetails({ itin_number: "9XX", itin_issue_date: "2020-01-01" }, { itin_number: "9XX", itin_issue_date: "2022-06-02" })
    expect(r2.find((r) => r.field === "itin_issue_date")?.status).toBe("only_kept")
  })
  it("counts the filled details", () => {
    expect(countFilledDetails({ phone: "1", passport_number: " ", gender: null, address_city: "x" })).toBe(2)
  })
})

describe("phone slots", () => {
  it("a number already on the kept contact in another slot is not copied again", () => {
    const rows = diffPersonalDetails({ phone: "+1 555 0100" }, { phone: "+1 555 0199", phone_2: "+1 (555) 0100" })
    expect(rows.find((r) => r.field === "phone_2")?.status).toBe("same")
    expect(rows.find((r) => r.field === "phone")?.status).toBe("conflict")
  })
})

describe("identity choices", () => {
  const rows = diffPersonalDetails(
    { passport_number: "A1", phone: "1", date_of_birth: "1990-01-01" },
    { passport_number: "B2", phone: "2", date_of_birth: "1990-01-01", itin_number: "9XX" },
  )
  it("requires a choice for an identity conflict, none for a plain one or a copy", () => {
    expect(unresolvedIdentityConflicts(rows, {}).map((r) => r.field)).toEqual(["passport_number"])
  })
  it("is resolved by an explicit choice either way", () => {
    expect(unresolvedIdentityConflicts(rows, { passport_number: "winner" })).toEqual([])
    expect(unresolvedIdentityConflicts(rows, { passport_number: "loser" })).toEqual([])
  })
  it("cleanChoices drops unknown fields, bad values and choices on rows that need none", () => {
    const c = cleanChoices(rows, { passport_number: "loser", phone: "nope", date_of_birth: "loser", email: "loser", itin_number: "winner" })
    expect(c).toEqual({ passport_number: "loser", itin_number: "winner" })
    expect(cleanChoices(rows, null)).toEqual({})
    expect(cleanChoices(rows, "x")).toEqual({})
  })
})

describe("suggestKeep", () => {
  const A = { id: "a", email: "info@x.com", workingLogin: false, companies: 1, details: 4, records: 5 }
  const B = { id: "b", email: "me@gmail.com", workingLogin: true, companies: 2, details: 4, records: 50 }
  it("the wanted email comes first, even against a working login", () => {
    expect(suggestKeep(A, B, " INFO@x.com ", "b")).toMatchObject({ keepId: "a", decidedBy: "wanted_email" })
  })
  it("a wanted email matching neither (or both) falls to the next rule", () => {
    expect(suggestKeep(A, B, "other@z.com", "a").decidedBy).toBe("working_login")
    expect(suggestKeep({ ...A, email: "same@x.com" }, { ...B, email: "same@x.com" }, "same@x.com", "a").decidedBy).toBe("working_login")
  })
  it("then the working login", () => {
    expect(suggestKeep(A, B, null, "a")).toMatchObject({ keepId: "b", decidedBy: "working_login" })
  })
  it("then the most companies, then the most records", () => {
    const a = { ...A, workingLogin: true }
    expect(suggestKeep(a, B, null, "a")).toMatchObject({ keepId: "b", decidedBy: "most_data" })
    expect(suggestKeep({ ...a, companies: 2 }, B, null, "a")).toMatchObject({ keepId: "b", decidedBy: "most_data" })
    expect(suggestKeep({ ...a, companies: 2, records: 99 }, B, null, "b")).toMatchObject({ keepId: "a", decidedBy: "most_data" })
  })
  it("then the one holding more personal details, then more records", () => {
    const a = { ...A, workingLogin: true, companies: 2, details: 6, records: 1 }
    expect(suggestKeep(a, { ...B, details: 2, records: 999 }, null, "b")).toMatchObject({ keepId: "a", decidedBy: "most_data" })
    expect(suggestKeep(a, { ...B, details: 2, records: 999 }, null, "b").reasons[0]).toMatch(/more of the person's details/)
    expect(suggestKeep({ ...a, details: 4 }, { ...B, details: 4, records: 999 }, null, "a").keepId).toBe("b")
  })
  it("a tie keeps the picked one", () => {
    expect(suggestKeep({ ...A, workingLogin: true, companies: 2, details: 4, records: 50 }, B, null, "a")).toMatchObject({ keepId: "a", decidedBy: "tie" })
  })
  it("never says a missing email matches an empty wanted email", () => {
    expect(suggestKeep({ ...A, email: null }, { ...B, email: null }, "", "a").decidedBy).toBe("working_login")
  })
})

describe("owner-less documents", () => {
  const docs = [
    { id: "1", category: 2, contact_id: null, account_id: "co1" },
    { id: "2", category: 2, contact_id: "someone", account_id: "co1" },
    { id: "3", category: 3, contact_id: null, account_id: "co1" },
    { id: "4", category: 2, contact_id: null, account_id: "other-co" },
    { id: "5", category: 2, contact_id: null, account_id: null },
  ]
  it("offers only personal, owner-less documents of the two contacts' companies", () => {
    expect(eligibleOwnerlessDocs(docs, ["co1"]).map((d) => d.id)).toEqual(["1"])
  })
  it("offers nothing when there is no company", () => {
    expect(eligibleOwnerlessDocs(docs, [])).toEqual([])
  })
  it("cleanDocumentIds keeps only offered ids, once", () => {
    expect(cleanDocumentIds(["1", "1", "9", 5, null], [{ id: "1" }])).toEqual(["1"])
    expect(cleanDocumentIds("1", [{ id: "1" }])).toEqual([])
  })
})
