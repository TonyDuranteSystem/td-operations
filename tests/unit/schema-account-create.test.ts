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
import { createAccountSchema, primaryContactSchema } from "@/lib/schemas/account-create"

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

// primaryContactSchema had ZERO test coverage before this — this is the one
// server-side gate on the New Account dialog's contact fields; if a
// client-side check is ever bypassed (disabled JS, a direct API call), this
// schema is what actually stops a blank name or a malformed email from
// being saved (found via an R093-verifier-prompted independent re-check,
// 2026-08-19, dev_task 693273fd).
const VALID_CONTACT = {
  first_name: "Jane",
  last_name: "Smith",
  email: "jane@example.com",
}

describe("primaryContactSchema — required fields", () => {
  it("accepts a fully valid contact", () => {
    const result = primaryContactSchema.safeParse(VALID_CONTACT)
    expect(result.success).toBe(true)
  })

  it("rejects a blank first_name", () => {
    const result = primaryContactSchema.safeParse({ ...VALID_CONTACT, first_name: "" })
    expect(result.success).toBe(false)
  })

  it("rejects a missing first_name", () => {
    const { first_name: _first_name, ...rest } = VALID_CONTACT
    const result = primaryContactSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it("rejects a blank last_name", () => {
    const result = primaryContactSchema.safeParse({ ...VALID_CONTACT, last_name: "" })
    expect(result.success).toBe(false)
  })

  it("rejects a missing last_name", () => {
    const { last_name: _last_name, ...rest } = VALID_CONTACT
    const result = primaryContactSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it("allows middle_name to be omitted", () => {
    const { middle_name: _middle_name, ...rest } = VALID_CONTACT as typeof VALID_CONTACT & { middle_name?: string }
    const result = primaryContactSchema.safeParse(rest)
    expect(result.success).toBe(true)
  })
})

describe("primaryContactSchema — email", () => {
  it("allows email to be omitted entirely", () => {
    const { email: _email, ...rest } = VALID_CONTACT
    const result = primaryContactSchema.safeParse(rest)
    expect(result.success).toBe(true)
  })

  it("allows an explicitly empty email string", () => {
    const result = primaryContactSchema.safeParse({ ...VALID_CONTACT, email: "" })
    expect(result.success).toBe(true)
  })

  it("rejects a malformed email instead of silently saving it", () => {
    const result = primaryContactSchema.safeParse({ ...VALID_CONTACT, email: "not-an-email" })
    expect(result.success).toBe(false)
  })
})

describe("primaryContactSchema — address fields are all optional", () => {
  it("accepts a contact with no address fields at all", () => {
    const result = primaryContactSchema.safeParse(VALID_CONTACT)
    expect(result.success).toBe(true)
  })

  it("accepts a contact with a full address", () => {
    const result = primaryContactSchema.safeParse({
      ...VALID_CONTACT,
      address_line1: "1 Main St",
      address_city: "Boston",
      address_state: "MA",
      address_zip: "02108",
      address_country: "USA",
    })
    expect(result.success).toBe(true)
  })
})
