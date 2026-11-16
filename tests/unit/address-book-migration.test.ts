/**
 * The address book foundation migration must (a) pass the table lock rule, (b) never touch the CRM tables, (c) keep the Personal book away from the AI read-only role,
 * and (d) seed no type (Antonio creates his own).
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { lockViolations, createdTables } from "@/lib/security/migration-lock-check"

const NAME = "20261114-2100-address-book-foundation.sql"
const sql = fs.readFileSync(path.join(process.cwd(), "scripts/migrations", NAME), "utf8")
const code = sql.replace(/--[^\n]*/g, " ")

describe("address book foundation migration", () => {
  it("passes the lock rule (RLS on, REVOKE from anon + authenticated, lock call)", () => {
    expect(lockViolations(NAME, sql)).toEqual([])
  })
  it("creates exactly the three address book tables", () => {
    expect(createdTables(sql).sort()).toEqual(["address_book_crm_labels", "address_book_entries", "address_book_personal"])
  })
  it("never alters, references or writes the CRM tables", () => {
    expect(code).not.toMatch(/references\s+(public\.)?(contacts|accounts|partners|leads)\b/i)
    expect(code).not.toMatch(/(alter\s+table|insert\s+into|update|delete\s+from)\s+(public\.)?(contacts|accounts|partners|leads|account_contacts)\b/i)
  })
  it("revokes the Personal table from the AI read-only role", () => {
    expect(code).toMatch(/revoke\s+all\s+on\s+public\.address_book_personal\s+from\s+ai_readonly/i)
  })
  it("seeds no type: only the catalog definition is inserted", () => {
    expect(code).toMatch(/insert\s+into\s+public\.catalog_definitions/i)
    expect(code).not.toMatch(/insert\s+into\s+public\.catalog_entries/i)
  })
  it("has an UNDO next to it", () => {
    expect(fs.existsSync(path.join(process.cwd(), "scripts/migrations", NAME.replace(/\.sql$/, ".UNDO.sql")))).toBe(true)
  })
})
