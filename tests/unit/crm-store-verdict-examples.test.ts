import { describe, it, expect } from "vitest"
import { computeVerdict, type VerdictInput } from "@/lib/crm-store/understand/verdict"
import { namePattern, exampleCheck, type ExampleRow } from "@/lib/crm-store/understand/examples"

const good: VerdictInput = {
  read: { ok: true, partial: false, hasWords: true },
  ai: { typeSlug: "office_lease", injection: false, nameRejected: false, failed: false },
  crm: "pass", example: "pass", ownerMismatch: false, duplicate: null,
}
describe("green needs EVERYTHING to agree; the AI's confidence is never an input", () => {
  it("all four proofs → green", () => expect(computeVerdict(good)).toEqual({ verdict: "green", reasons: [] }))
  it.each([
    ["unreadable", { read: { ok: false, partial: false, hasWords: false } }, "unreadable"],
    ["partly read", { read: { ok: true, partial: true, hasWords: true } }, "partly_read"],
    ["no words", { read: { ok: true, partial: false, hasWords: false } }, "no_words"],
    ["no type", { ai: { ...good.ai!, typeSlug: null } }, "no_type"],
    ["injection", { ai: { ...good.ai!, injection: true } }, "injection"],
    ["bad name", { ai: { ...good.ai!, nameRejected: true } }, "bad_name"],
    ["AI down", { ai: null }, "ai_failed"],
    ["CRM disagrees", { crm: "fail" }, "crm_disagrees"],
    ["no CRM record", { crm: "none" }, "crm_none"],
    ["no example yet", { example: "none" }, "no_example"],
    ["examples disagree", { example: "fail" }, "example_disagrees"],
    ["other client", { ownerMismatch: true }, "wrong_client"],
    ["twin differs", { duplicate: "different_words" }, "duplicate_differs"],
    ["twin only minor marks", { duplicate: "minor_marks" }, "duplicate_differs"],
  ] as const)("%s → red", (_n, patch, reason) => {
    const r = computeVerdict({ ...good, ...(patch as Partial<VerdictInput>) })
    expect(r.verdict).toBe("red")
    expect(r.reasons).toContain(reason)
  })
  it("an exact-bytes twin does not make a file red by itself", () => expect(computeVerdict({ ...good, duplicate: "same_bytes" }).verdict).toBe("green"))
})

describe("learning examples", () => {
  it("name patterns drop the extension, digits and the owner's own words", () => {
    expect(namePattern("Form SS-4 - DIECI DIECI COMPANY LLC - Mario Cerbone.pdf", ["dieci dieci company llc", "mario cerbone"])).toBe("form ss-#")
    expect(namePattern("Invoice 2025-0012.pdf")).toBe("invoice #-#")
  })
  const ex = (type: string, pat: string, folder: string | null = null): ExampleRow => ({ id: type + pat, type_slug: type, name_pattern: pat, folder_kind: folder })
  it("no similar example → none (so red until a person has confirmed one)", () => expect(exampleCheck([], "office_lease", "Lease.pdf", null)).toBe("none"))
  it("a confirmed example with the same pattern agrees", () => expect(exampleCheck([ex("office_lease", "office lease")], "office_lease", "Office Lease - Acme LLC.pdf", null, ["acme llc"])).toBe("pass"))
  it("a correction to a different type disagrees", () => expect(exampleCheck([ex("articles_of_organization", "resolution")], "resolution_minutes", "Resolution.pdf", null)).toBe("fail"))
  it("a wrong correction cannot turn a file green alone: the majority of similar examples decides", () => {
    const list = [ex("tax_return", "resolution"), ex("articles_of_organization", "resolution"), ex("articles_of_organization", "resolution")]
    expect(exampleCheck(list, "articles_of_organization", "Resolution.pdf", null)).toBe("pass")
    expect(exampleCheck(list, "tax_return", "Resolution.pdf", null)).toBe("fail")
  })
})
