import { describe, it, expect } from "vitest"
import { creditScopeFor } from "@/lib/portal/td-invoice"

describe("creditScopeFor", () => {
  it("account wins by default (existing behaviour)", () => {
    expect(creditScopeFor("acct", "person")).toEqual({ accountId: "acct" })
  })
  it("person when there is no account", () => {
    expect(creditScopeFor(null, "person")).toEqual({ contactId: "person" })
  })
  it("'contact' forces the person's pool even on a company-addressed invoice (signing invoice, S1)", () => {
    expect(creditScopeFor("acct", "person", "contact")).toEqual({ contactId: "person" })
  })
  it("'contact' with no person falls back to the account", () => {
    expect(creditScopeFor("acct", null, "contact")).toEqual({ accountId: "acct" })
  })
})
