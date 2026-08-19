/**
 * lib/schemas/account-create.ts — createAccountSchema unit tests.
 *
 * Focused on account_type: the New Account dialog's Role field resolves to
 * Client or One-Time, defaulting to Client when the caller omits it (the
 * dialog itself always sends a value, but the schema shouldn't rely on
 * that). 'Partner' is deliberately NOT offered at creation — it's a
 * narrower, unrelated tag (exempts a company from the data-completeness
 * audit) that looks like it registers a referral partner but doesn't; that
 * real flow is the Partners page's own "New Partner" button. Pulled from
 * this dialog 2026-08-19 after it caused exactly that confusion.
 */

import { describe, it, expect } from "vitest"
import { createAccountSchema } from "@/lib/schemas/account-create"

const BASE = {
  company_name: "Test LLC",
  entity_type: "Single Member LLC" as const,
  member_structure: "single_member" as const,
  state_of_formation: "Wyoming",
}

describe("createAccountSchema — account_type", () => {
  it("defaults to Client when not supplied", () => {
    const result = createAccountSchema.safeParse(BASE)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.account_type).toBe("Client")
  })

  it("accepts One-Time", () => {
    const result = createAccountSchema.safeParse({ ...BASE, account_type: "One-Time" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.account_type).toBe("One-Time")
  })

  it("rejects Partner — not offered at creation, only via the real partner flow", () => {
    const result = createAccountSchema.safeParse({ ...BASE, account_type: "Partner" })
    expect(result.success).toBe(false)
  })

  it("rejects a value outside the two creatable account types", () => {
    const result = createAccountSchema.safeParse({ ...BASE, account_type: "Vendor" })
    expect(result.success).toBe(false)
  })
})

describe("createAccountSchema — required fields", () => {
  it("rejects a blank state of formation", () => {
    const result = createAccountSchema.safeParse({ ...BASE, state_of_formation: "" })
    expect(result.success).toBe(false)
  })

  it("rejects a missing entity_type", () => {
    const { entity_type: _entity_type, ...rest } = BASE
    const result = createAccountSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it("rejects a missing member_structure", () => {
    const { member_structure: _member_structure, ...rest } = BASE
    const result = createAccountSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})
