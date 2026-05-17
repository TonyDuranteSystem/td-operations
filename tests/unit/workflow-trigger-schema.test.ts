/**
 * Slice 8 Pass 6 — workflow-trigger-schema unit tests
 *
 * Covers the parser + filter-matching helpers used by the generic dispatcher.
 * Pure logic, no I/O. Cheap to test exhaustively.
 */

import { describe, it, expect } from "vitest"
import { parseTriggeredBy, matchesFilter } from "@/lib/tasks/workflow-trigger-schema"

describe("parseTriggeredBy", () => {
  it("parses a valid form_submission trigger with filter", () => {
    const result = parseTriggeredBy({
      source: "form_submission",
      table: "banking_submissions",
      filter: { provider: "payset" },
    })
    expect(result).not.toBeNull()
    expect(result?.source).toBe("form_submission")
    if (result?.source === "form_submission") {
      expect(result.table).toBe("banking_submissions")
      expect(result.filter).toEqual({ provider: "payset" })
    }
  })

  it("parses a valid form_submission trigger WITHOUT filter (matches all)", () => {
    const result = parseTriggeredBy({
      source: "form_submission",
      table: "tax_return_submissions",
    })
    expect(result).not.toBeNull()
    if (result?.source === "form_submission") {
      expect(result.filter).toBeUndefined()
    }
  })

  it("returns null on null / undefined input", () => {
    expect(parseTriggeredBy(null)).toBeNull()
    expect(parseTriggeredBy(undefined)).toBeNull()
  })

  it("returns null on unknown source", () => {
    expect(
      parseTriggeredBy({
        source: "sd_created",
        table: "service_deliveries",
      }),
    ).toBeNull()
  })

  it("returns null on missing table", () => {
    expect(parseTriggeredBy({ source: "form_submission" })).toBeNull()
  })

  it("returns null on empty table string", () => {
    expect(parseTriggeredBy({ source: "form_submission", table: "" })).toBeNull()
  })

  it("returns null on non-primitive filter value", () => {
    expect(
      parseTriggeredBy({
        source: "form_submission",
        table: "x",
        filter: { nested: { obj: "no" } },
      }),
    ).toBeNull()
  })
})

describe("matchesFilter", () => {
  it("returns true when filter is undefined (matches all)", () => {
    expect(matchesFilter(undefined, { provider: "payset" })).toBe(true)
  })

  it("returns true when filter is empty object", () => {
    expect(matchesFilter({}, { provider: "payset" })).toBe(true)
  })

  it("returns true when single-key filter matches", () => {
    expect(matchesFilter({ provider: "payset" }, { provider: "payset", id: "x" })).toBe(true)
  })

  it("returns false when single-key filter does not match", () => {
    expect(matchesFilter({ provider: "payset" }, { provider: "relay" })).toBe(false)
  })

  it("returns true when multi-key filter ALL match", () => {
    expect(
      matchesFilter({ provider: "payset", status: "completed" }, { provider: "payset", status: "completed", extra: "ok" }),
    ).toBe(true)
  })

  it("returns false when ANY filter key fails to match (AND semantics)", () => {
    expect(
      matchesFilter({ provider: "payset", status: "completed" }, { provider: "payset", status: "pending" }),
    ).toBe(false)
  })

  it("returns false when filter key missing on event", () => {
    expect(matchesFilter({ provider: "payset" }, { other: "field" })).toBe(false)
  })

  it("uses strict equality (no type coercion)", () => {
    expect(matchesFilter({ count: 5 }, { count: "5" })).toBe(false)
    expect(matchesFilter({ active: true }, { active: "true" })).toBe(false)
  })

  it("supports boolean filter values", () => {
    expect(matchesFilter({ active: true }, { active: true })).toBe(true)
    expect(matchesFilter({ active: false }, { active: true })).toBe(false)
  })

  it("supports numeric filter values", () => {
    expect(matchesFilter({ tax_year: 2025 }, { tax_year: 2025 })).toBe(true)
    expect(matchesFilter({ tax_year: 2025 }, { tax_year: 2024 })).toBe(false)
  })

  it("multi-key partial match (filter has key, event missing it) returns false", () => {
    expect(matchesFilter({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })
})

// ── Slice 9: sd_created trigger variant ────────────────────────────────────

describe("parseTriggeredBy — sd_created (Slice 9)", () => {
  it("parses a valid sd_created trigger with service_type filter", () => {
    const result = parseTriggeredBy({
      source: "sd_created",
      filter: { service_type: "Company Formation" },
    })
    expect(result).not.toBeNull()
    expect(result?.source).toBe("sd_created")
    if (result?.source === "sd_created") {
      expect(result.filter.service_type).toBe("Company Formation")
    }
  })

  it("returns null when sd_created is missing required filter", () => {
    expect(parseTriggeredBy({ source: "sd_created" })).toBeNull()
  })

  it("returns null when sd_created filter is missing service_type", () => {
    expect(parseTriggeredBy({ source: "sd_created", filter: {} })).toBeNull()
  })

  it("returns null when service_type is empty string", () => {
    expect(parseTriggeredBy({ source: "sd_created", filter: { service_type: "" } })).toBeNull()
  })

  it("does NOT confuse sd_created with form_submission (different sources)", () => {
    const fs = parseTriggeredBy({ source: "form_submission", table: "x" })
    const sd = parseTriggeredBy({ source: "sd_created", filter: { service_type: "Company Closure" } })
    expect(fs?.source).toBe("form_submission")
    expect(sd?.source).toBe("sd_created")
  })
})
