import { describe, it, expect } from "vitest"
import { rejectIfNotReadOnly } from "@/lib/mcp/tools/hermes-read"

describe("crm_query rejectIfNotReadOnly (app-layer read-only gate)", () => {
  it("allows a plain SELECT", () => {
    expect(rejectIfNotReadOnly("SELECT company_name, status FROM accounts LIMIT 20")).toBeNull()
  })

  it("allows a read-only WITH … SELECT", () => {
    expect(rejectIfNotReadOnly("WITH a AS (SELECT id FROM accounts) SELECT count(*) FROM a")).toBeNull()
  })

  it.each([
    ["UPDATE", "UPDATE accounts SET status='x' WHERE id='1'"],
    ["DELETE", "DELETE FROM accounts WHERE id='1'"],
    ["INSERT", "INSERT INTO accounts(company_name) VALUES('x')"],
    ["DROP", "DROP TABLE accounts"],
    ["TRUNCATE", "TRUNCATE accounts"],
    ["ALTER", "ALTER TABLE accounts ADD COLUMN x int"],
  ])("rejects %s", (_label, q) => {
    expect(rejectIfNotReadOnly(q)).not.toBeNull()
  })

  it("rejects a data-modifying CTE", () => {
    expect(
      rejectIfNotReadOnly("WITH w AS (DELETE FROM accounts RETURNING id) SELECT * FROM w"),
    ).not.toBeNull()
  })

  it("rejects multi-statement with a mutation", () => {
    expect(rejectIfNotReadOnly("SELECT 1; DELETE FROM accounts")).not.toBeNull()
  })

  it("does not start with SELECT/WITH → rejected", () => {
    expect(rejectIfNotReadOnly("EXPLAIN ANALYZE SELECT * FROM accounts")).not.toBeNull()
  })

  it.each([
    "SELECT * FROM oauth_tokens",
    "SELECT access_token FROM qb_tokens",
    "SELECT * FROM hc_tokens",
    "SELECT token FROM portal_welcome_tokens",
    "SELECT * FROM oauth_users JOIN accounts USING (id)",
  ])("rejects credential/token table access: %s", (q) => {
    expect(rejectIfNotReadOnly(q)).toMatch(/credential\/token tables/)
  })
})
