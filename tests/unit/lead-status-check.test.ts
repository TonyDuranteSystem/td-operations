import { describe, it, expect } from "vitest"
import { isUnresolvedLeadWarning } from "@/lib/operations/lead-status-check"

describe("isUnresolvedLeadWarning", () => {
  it("is false for a genuinely Converted lead", () => {
    expect(isUnresolvedLeadWarning({ status: "Converted", existing_client_contact_id: null })).toBe(false)
  })

  it("is true for a genuine open lead — not Converted, not tagged", () => {
    expect(isUnresolvedLeadWarning({ status: "Call Scheduled", existing_client_contact_id: null })).toBe(true)
  })

  it("is false for a lead tagged as an existing-client booking, even though status isn't Converted", () => {
    expect(isUnresolvedLeadWarning({ status: "Call Scheduled", existing_client_contact_id: "contact-1" })).toBe(false)
  })

  it("is false when both Converted and tagged (no double-flag)", () => {
    expect(isUnresolvedLeadWarning({ status: "Converted", existing_client_contact_id: "contact-1" })).toBe(false)
  })

  it("treats a null status as unresolved when untagged", () => {
    expect(isUnresolvedLeadWarning({ status: null, existing_client_contact_id: null })).toBe(true)
  })
})
