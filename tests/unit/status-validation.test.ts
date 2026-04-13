/**
 * Tests for validateStatusField — crm_update_record status guard rail.
 * Validates ENUM-backed table/field pairs only; unmapped tables pass through.
 */

import { describe, it, expect } from "vitest"
import { validateStatusField, STATUS_VALIDATION_MAP } from "@/lib/mcp/tools/crm"

describe("validateStatusField", () => {
  // ── Valid values (should return null) ──

  it("accepts valid accounts.status", () => {
    expect(validateStatusField("accounts", { status: "Active" })).toBeNull()
    expect(validateStatusField("accounts", { status: "Closed" })).toBeNull()
    expect(validateStatusField("accounts", { status: "Pending Formation" })).toBeNull()
  })

  it("accepts valid payments.status", () => {
    expect(validateStatusField("payments", { status: "Paid" })).toBeNull()
    expect(validateStatusField("payments", { status: "Pending" })).toBeNull()
    expect(validateStatusField("payments", { status: "Not Invoiced" })).toBeNull()
    expect(validateStatusField("payments", { status: "Cancelled" })).toBeNull()
  })

  it("accepts valid tasks.status", () => {
    expect(validateStatusField("tasks", { status: "To Do" })).toBeNull()
    expect(validateStatusField("tasks", { status: "Done" })).toBeNull()
  })

  it("accepts valid leads.status", () => {
    expect(validateStatusField("leads", { status: "New" })).toBeNull()
    expect(validateStatusField("leads", { status: "Paid" })).toBeNull()
    expect(validateStatusField("leads", { status: "Converted" })).toBeNull()
  })

  it("accepts valid deals.stage", () => {
    expect(validateStatusField("deals", { stage: "Paid" })).toBeNull()
    expect(validateStatusField("deals", { stage: "Closed Won" })).toBeNull()
  })

  it("accepts valid tax_returns.status", () => {
    expect(validateStatusField("tax_returns", { status: "Payment Pending" })).toBeNull()
    expect(validateStatusField("tax_returns", { status: "Activated - Need Link" })).toBeNull()
    expect(validateStatusField("tax_returns", { status: "Extension Requested" })).toBeNull()
  })

  // ── Invalid values (should return error string) ──

  it("rejects lowercase 'paid' for payments.status", () => {
    const result = validateStatusField("payments", { status: "paid" })
    expect(result).toContain("Invalid status value")
    expect(result).toContain('"paid"')
  })

  it("rejects 'Inactive' for accounts.status", () => {
    const result = validateStatusField("accounts", { status: "Inactive" })
    expect(result).toContain("Invalid status value")
    expect(result).toContain('"Inactive"')
  })

  it("rejects lowercase 'todo' for tasks.status", () => {
    const result = validateStatusField("tasks", { status: "todo" })
    expect(result).toContain("Invalid status value")
  })

  it("rejects wrong casing for deals.stage", () => {
    const result = validateStatusField("deals", { stage: "paid" })
    expect(result).toContain("Invalid stage value")
    expect(result).toContain('"paid"')
  })

  // ── Unmapped tables pass through (should return null) ──

  it("passes through unmapped tables with no validation", () => {
    expect(validateStatusField("contacts", { status: "anything" })).toBeNull()
    expect(validateStatusField("service_deliveries", { status: "whatever" })).toBeNull()
    expect(validateStatusField("conversations", { status: "xyz" })).toBeNull()
    expect(validateStatusField("deadlines", { status: "foo" })).toBeNull()
    expect(validateStatusField("services", { status: "bar" })).toBeNull()
  })

  // ── Non-status field updates pass through ──

  it("passes through when update does not touch the validated field", () => {
    expect(validateStatusField("accounts", { notes: "test" })).toBeNull()
    expect(validateStatusField("payments", { amount: 100 })).toBeNull()
    expect(validateStatusField("deals", { deal_value: 5000 })).toBeNull()
  })

  // ── Validation map structure ──

  it("has exactly 6 mapped tables in first pass", () => {
    expect(Object.keys(STATUS_VALIDATION_MAP)).toHaveLength(6)
    expect(Object.keys(STATUS_VALIDATION_MAP).sort()).toEqual([
      "accounts", "deals", "leads", "payments", "tasks", "tax_returns",
    ])
  })

  it("deals validates 'stage' field, not 'status'", () => {
    expect(STATUS_VALIDATION_MAP["deals"].field).toBe("stage")
    // status field on deals should pass through
    expect(validateStatusField("deals", { status: "anything" })).toBeNull()
  })
})
