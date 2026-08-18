import { describe, it, expect } from "vitest"
import { draftToCondition, emptyDraft, type DraftCondition } from "@/lib/research/draft-condition"
import { getEntity } from "@/lib/research/entity-registry"

// Regression coverage for the bug Antonio hit live: a filter's operator+value
// were fully specified in the UI, but the results below still reflected the
// OLD filter set because nothing had actually been applied yet. The fix makes
// the UI auto-apply the moment a condition becomes complete; this test locks
// down the underlying completeness check that decision is built on —
// draftToCondition must return null for "not finished yet" and a real
// condition for "finished," for every field type, so the UI can never again
// show a result set that silently doesn't match what's configured on screen.

const accounts = getEntity("accounts")!
const formationDate = accounts.fields.find(f => f.key === "formation_date")!
const companyName = accounts.fields.find(f => f.key === "company_name")!
const status = accounts.fields.find(f => f.key === "status")!
const portalAccount = accounts.fields.find(f => f.key === "portal_account")!

describe("research console — draft completeness (auto-apply gate)", () => {
  it("a date filter with only the operator picked (Antonio's exact repro) is NOT yet applicable", () => {
    const draft: DraftCondition = { ...emptyDraft("formation_date", "date"), operator: "before" }
    expect(draftToCondition(formationDate, draft)).toBeNull()
  })

  it("the same date filter becomes applicable the instant a value is set", () => {
    const draft: DraftCondition = { ...emptyDraft("formation_date", "date"), operator: "before", value: "2024-11-17" }
    expect(draftToCondition(formationDate, draft)).toEqual({
      field: "formation_date",
      operator: "before",
      value: "2024-11-17",
    })
  })

  it("a 'between' date filter is NOT applicable until both ends are set", () => {
    const onlyFirst: DraftCondition = { ...emptyDraft("formation_date", "date"), operator: "between", value: "2024-01-01" }
    expect(draftToCondition(formationDate, onlyFirst)).toBeNull()

    const both: DraftCondition = { ...onlyFirst, value2: "2024-12-31" }
    expect(draftToCondition(formationDate, both)).toEqual({
      field: "formation_date",
      operator: "between",
      value: "2024-01-01",
      value2: "2024-12-31",
    })
  })

  it("a text filter with an empty value is not applicable; typed text is", () => {
    const empty: DraftCondition = { ...emptyDraft("company_name", "text"), operator: "contains", value: "" }
    expect(draftToCondition(companyName, empty)).toBeNull()

    const filled: DraftCondition = { ...empty, value: "acme" }
    expect(draftToCondition(companyName, filled)).toEqual({ field: "company_name", operator: "contains", value: "acme" })
  })

  it("a multi-select filter is not applicable with zero boxes checked; one checked box is enough", () => {
    const none: DraftCondition = { ...emptyDraft("status", "select"), operator: "is_any_of", values: [] }
    expect(draftToCondition(status, none)).toBeNull()

    const one: DraftCondition = { ...none, values: ["Active"] }
    expect(draftToCondition(status, one)).toEqual({ field: "status", operator: "is_any_of", values: ["Active"] })
  })

  it("a no-value operator (is true/is false/is empty) is applicable the moment it's picked, no value needed", () => {
    const draft: DraftCondition = { ...emptyDraft("portal_account", "boolean"), operator: "is_true" }
    expect(draftToCondition(portalAccount, draft)).toEqual({ field: "portal_account", operator: "is_true" })
  })
})
