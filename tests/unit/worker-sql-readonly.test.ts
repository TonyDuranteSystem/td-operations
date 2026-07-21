/**
 * Slack worker read-only SQL — guard tests.
 *
 * Covers assertWorkerReadOnlySql (the pure validator that gates run_sql_query for the
 * Slack worker's dig-in gear) and the structural invariant that the raw-SQL tool is
 * NOT in the base WORKER_TOOLS set (so it never reaches the Hermes research worker —
 * R108). The guard is the only thing standing between an autonomous LLM and the DB,
 * so these assertions are the contract: SELECT/WITH only, single statement, no writes,
 * no auth/token/password tables.
 */

import { describe, it, expect } from "vitest"
import {
  assertWorkerReadOnlySql,
  RUN_SQL_QUERY_TOOL,
  WORKER_TOOLS,
} from "@/lib/ai-agent/worker-tools"

function ok(sql: string) {
  const r = assertWorkerReadOnlySql(sql)
  expect(r.error, `expected OK for: ${sql} — got error: ${r.error}`).toBeNull()
  expect(typeof r.sql).toBe("string")
  return r
}
function rejected(sql: unknown) {
  const r = assertWorkerReadOnlySql(sql)
  expect(r.sql, `expected REJECT for: ${String(sql)}`).toBeNull()
  expect(typeof r.error).toBe("string")
  return r
}

describe("assertWorkerReadOnlySql — accepts read-only queries", () => {
  it("allows a plain SELECT", () => {
    const r = ok("SELECT id, portal_tier FROM accounts WHERE id = '123' LIMIT 5")
    expect(r.sql).toMatch(/^SELECT/i)
  })

  it("allows a WITH … SELECT (read-only CTE)", () => {
    ok("WITH x AS (SELECT id FROM accounts) SELECT * FROM x LIMIT 1")
  })

  it("is case-insensitive on the leading keyword", () => {
    ok("select 1")
    ok("  With y as (select 1) select * from y")
  })

  it("strips a single trailing semicolon", () => {
    const r = assertWorkerReadOnlySql("SELECT 1;")
    expect(r.error).toBeNull()
    expect(r.sql).not.toBeNull()
    expect(r.sql?.endsWith(";")).toBe(false)
  })

  it("does not trip on columns that merely contain a keyword substring", () => {
    // created_at / updated_at / settings contain CREATE/UPDATE/SET as substrings but
    // not as whole words — must NOT be rejected.
    ok("SELECT created_at, updated_at FROM accounts LIMIT 1")
    ok("SELECT * FROM account_settings LIMIT 1")
  })
})

describe("assertWorkerReadOnlySql — rejects writes & DDL", () => {
  for (const sql of [
    "INSERT INTO accounts (id) VALUES ('x')",
    "UPDATE accounts SET portal_tier = 'active'",
    "DELETE FROM accounts WHERE id = 'x'",
    "DROP TABLE accounts",
    "ALTER TABLE accounts ADD COLUMN x int",
    "CREATE TABLE x (id int)",
    "TRUNCATE accounts",
    "GRANT SELECT ON accounts TO public",
  ]) {
    it(`rejects: ${sql.slice(0, 28)}…`, () => rejected(sql))
  }

  it("rejects a write hidden in a CTE (starts with WITH but writes)", () => {
    rejected("WITH d AS (DELETE FROM accounts RETURNING id) SELECT * FROM d")
  })

  it("rejects stacked statements (semicolon in the middle)", () => {
    rejected("SELECT 1; DELETE FROM accounts")
    rejected("SELECT 1; SELECT 2")
  })

  it("rejects a non-SELECT/WITH leading statement", () => {
    rejected("EXPLAIN SELECT * FROM accounts")
    rejected("SHOW TABLES")
  })
})

describe("assertWorkerReadOnlySql — blocks protected tables", () => {
  for (const sql of [
    "SELECT * FROM auth.users",
    "SELECT raw_app_meta_data FROM auth.users WHERE email = 'x'",
    "SELECT * FROM oauth_tokens",
    "SELECT * FROM oauth_codes",
    "SELECT * FROM oauth_users",
    "SELECT * FROM qb_tokens",
    "SELECT * FROM hc_tokens",
    "SELECT * FROM portal_welcome_tokens",
    "SELECT * FROM push_subscriptions",
    "SELECT encrypted_password FROM contacts",
  ]) {
    it(`rejects protected: ${sql.slice(0, 34)}…`, () => rejected(sql))
  }
})

describe("assertWorkerReadOnlySql — rejects malformed input", () => {
  it("rejects empty / whitespace / non-string", () => {
    rejected("")
    rejected("   ")
    rejected(undefined)
    rejected(null)
    rejected(42)
  })
})

describe("run_sql_query tool wiring", () => {
  it("is NOT in the base WORKER_TOOLS (stays out of the Hermes research worker — R108)", () => {
    expect(WORKER_TOOLS.some((t) => t.name === "run_sql_query")).toBe(false)
  })

  it("RUN_SQL_QUERY_TOOL is named run_sql_query and requires a query param", () => {
    expect(RUN_SQL_QUERY_TOOL.name).toBe("run_sql_query")
    expect(RUN_SQL_QUERY_TOOL.parameters.required).toContain("query")
  })
})

describe("assertWorkerReadOnlySql — KNOWN LIMIT of the regex layer (closed by the DB role, not here)", () => {
  // The consolidated dashboard/sidebar SQL tool now runs behind this guard + the
  // exec_sql_readonly RPC. But name-obfuscation (concat/query_to_xml) hides the target
  // table from ANY text match, so the app-layer regex CANNOT be the confidentiality
  // boundary. These pass the guard on purpose — documenting that the durable fix is the
  // low-privilege DB role (fix/ai-sql-hardening DB piece), which denies these at the
  // planner regardless of spelling. If a future change makes the regex claim to block
  // these, that is false assurance — the role is the boundary.
  it("does NOT catch a concat-obfuscated auth.users read (regex is not the boundary)", () => {
    const r = assertWorkerReadOnlySql(
      "SELECT query_to_xml(concat('SEL','ECT email FROM au','th.users'), false, true, '')",
    )
    // Guard lets it through — only the DB role stops it. This assertion pins the
    // limitation so nobody mistakes the regex for the security control.
    expect(r.error).toBeNull()
  })
})

describe("runReadOnlySqlForWorker — audit source label", () => {
  it("accepts a source-label arg (so the consolidated sidebar path is not mislabelled as Slack)", async () => {
    // Signature contract only (no DB in unit tests): the second arg is the audit actor.
    // Default is the Slack worker; the sidebar entry passes 'claude.sidebar'.
    const { runReadOnlySqlForWorker } = await import("@/lib/ai-agent/worker-tools")
    expect(runReadOnlySqlForWorker.length).toBeGreaterThanOrEqual(1)
    // A rejected query returns a JSON error string without ever touching the DB, so this
    // exercises the guard path with the actor arg present and confirms it never throws.
    const out = await runReadOnlySqlForWorker({ query: "DELETE FROM accounts" }, "claude.sidebar")
    expect(out).toContain("error")
  })
})
