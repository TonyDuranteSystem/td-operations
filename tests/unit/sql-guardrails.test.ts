/**
 * P2.3 — execute_sql guardrail tests.
 *
 * Exercises the pure validator (`validateSQL`, `thresholdFor`) exported
 * from lib/mcp/tools/sql.ts. The tool handler's live `reason:` + dry-run
 * flow is exercised end-to-end via the MCP server in production; here we
 * cover the pure invariants the plan §4 P2.3 directives codify.
 */

import { describe, it, expect } from "vitest"
import {
  PROTECTED_TABLES,
  PROTECTED_TABLE_THRESHOLDS,
  DEFAULT_DRY_RUN_THRESHOLD,
  thresholdFor,
  validateSQL,
} from "@/lib/mcp/tools/sql"

describe("P2.3 — PROTECTED_TABLES expanded", () => {
  it("still includes the original 12 plan-era tables", () => {
    for (const t of [
      "accounts", "contacts", "payments", "services",
      "service_deliveries", "tax_returns", "tasks", "documents",
      "deals", "leads", "offers", "deadlines",
    ]) {
      expect(PROTECTED_TABLES).toContain(t)
    }
  })

  it("adds the 2 heavily-written tables from P2.2 classification", () => {
    // "services" was already present. New additions per P2.2:
    expect(PROTECTED_TABLES).toContain("pipeline_stages")
    expect(PROTECTED_TABLES).toContain("client_invoices")
  })
})

describe("P2.3 — per-table dry-run threshold", () => {
  it("service_deliveries is lowered to 10", () => {
    expect(PROTECTED_TABLE_THRESHOLDS.service_deliveries).toBe(10)
    expect(thresholdFor("service_deliveries")).toBe(10)
  })

  it("default protected tables retain 50", () => {
    expect(DEFAULT_DRY_RUN_THRESHOLD).toBe(50)
    for (const t of ["accounts", "contacts", "payments", "offers", "pipeline_stages"]) {
      expect(thresholdFor(t)).toBe(50)
    }
  })
})

describe("P2.3 — validateSQL flags protected-table touches", () => {
  it("UPDATE on protected table sets protectedTableTouched=true", () => {
    const r = validateSQL("UPDATE accounts SET status = 'Active' WHERE id = 'x'")
    expect(r.allowed).toBe(true)
    expect(r.hasMutation).toBe(true)
    expect(r.protectedTableTouched).toBe(true)
    expect(r.dryRunNeeded).toBe(true)
  })

  it("UPDATE on a newly-added protected table (client_invoices) is flagged", () => {
    const r = validateSQL("UPDATE client_invoices SET status = 'Paid' WHERE id = 'x'")
    expect(r.protectedTableTouched).toBe(true)
    expect(r.dryRunTable).toBe("client_invoices")
  })

  it("UPDATE on an unprotected table does NOT flag protected-touch", () => {
    const r = validateSQL("UPDATE dev_tasks SET status = 'done' WHERE id = 'x'")
    expect(r.allowed).toBe(true)
    expect(r.protectedTableTouched).toBe(false)
  })

  it("CTE with a DELETE body on a protected table is flagged", () => {
    const r = validateSQL(
      "WITH d AS (DELETE FROM service_deliveries WHERE id = 'x' RETURNING id) SELECT count(*) FROM d"
    )
    expect(r.protectedTableTouched).toBe(true)
    expect(r.mutationType).toBe("DELETE")
    expect(r.dryRunTable).toBe("service_deliveries")
  })

  it("WHERE-less UPDATE/DELETE still blocked (unchanged behavior)", () => {
    const r = validateSQL("UPDATE accounts SET status = 'Active'")
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/without WHERE clause is blocked/i)
  })
})

describe("P2.3 — INSERT dry-run (extends plan §4 line 550)", () => {
  it("single-row INSERT on protected table reports insertRowCount=1", () => {
    const r = validateSQL(
      "INSERT INTO accounts (id, company_name) VALUES ('a','Test LLC')"
    )
    expect(r.allowed).toBe(true)
    expect(r.mutationType).toBe("INSERT")
    expect(r.dryRunNeeded).toBe(true)
    expect(r.insertRowCount).toBe(1)
    expect(r.protectedTableTouched).toBe(true)
  })

  it("multi-row INSERT counts VALUES tuples", () => {
    const r = validateSQL(
      "INSERT INTO accounts (id, company_name) VALUES ('a','A LLC'), ('b','B LLC'), ('c','C LLC')"
    )
    expect(r.mutationType).toBe("INSERT")
    expect(r.insertRowCount).toBe(3)
  })

  it("INSERT ... SELECT conservatively counts as 1 row", () => {
    const r = validateSQL(
      "INSERT INTO accounts (id, company_name) SELECT id, company_name FROM accounts_staging"
    )
    expect(r.mutationType).toBe("INSERT")
    // No VALUES keyword → insertRowCount stays at 1 (conservative default).
    expect(r.insertRowCount).toBe(1)
  })

  it("INSERT on unprotected table is allowed without dry-run flag", () => {
    const r = validateSQL(
      "INSERT INTO dev_tasks (title, status) VALUES ('test','todo')"
    )
    expect(r.mutationType).toBe("INSERT")
    expect(r.protectedTableTouched).toBe(false)
    expect(r.dryRunNeeded).toBe(false)
  })
})
