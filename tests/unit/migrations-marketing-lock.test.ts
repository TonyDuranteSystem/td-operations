/**
 * The standing check behind the marketing database lock: EVERY migration newer than the lock that creates a table must keep it locked.
 * Also pins the checker itself with synthetic SQL so it cannot go vacuous.
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { createdTables, lockViolations, migrationPrefix } from "@/lib/security/migration-lock-check"

describe("lockViolations (the checker)", () => {
  const NEW = "20261101-0900-example.sql"
  it("a table created without the lock call is reported", () => {
    expect(lockViolations(NEW, "CREATE TABLE public.client_notes (id uuid);")).toHaveLength(1)
  })
  it("the same migration with the lock call at the end passes", () => {
    expect(lockViolations(NEW, "CREATE TABLE client_notes (id uuid);\nSELECT public.marketing_lock_all_tables();")).toEqual([])
  })
  it("a call that exists only inside a comment does not count", () => {
    expect(lockViolations(NEW, "CREATE TABLE client_notes (id uuid);\n-- SELECT public.marketing_lock_all_tables();")).toHaveLength(1)
    expect(lockViolations(NEW, "CREATE TABLE client_notes (id uuid);\n/* SELECT public.marketing_lock_all_tables(); */")).toHaveLength(1)
  })
  it("a marketing table needs row-level security switched on in the same file", () => {
    expect(lockViolations(NEW, "CREATE TABLE IF NOT EXISTS marketing_leads (id uuid);")).toHaveLength(1)
    expect(lockViolations(NEW, "CREATE TABLE IF NOT EXISTS marketing_leads (id uuid);\nALTER TABLE marketing_leads ENABLE ROW LEVEL SECURITY;")).toEqual([])
  })
  it("a migration with no table, an UNDO file, and migrations from before the rule are not checked", () => {
    expect(lockViolations(NEW, "ALTER TABLE accounts ADD COLUMN x int;")).toEqual([])
    expect(lockViolations("20261101-0900-example.UNDO.sql", "CREATE TABLE client_notes (id uuid);")).toEqual([])
    expect(lockViolations("20261018-0100-old.sql", "CREATE TABLE client_notes (id uuid);")).toEqual([])
    expect(lockViolations("no-date.sql", "CREATE TABLE client_notes (id uuid);")).toEqual([])
  })
  it("reads table names with quotes, schema and IF NOT EXISTS", () => {
    expect(createdTables('CREATE TABLE IF NOT EXISTS public."Foo_Bar" (x int); create table baz (y int);')).toEqual(["foo_bar", "baz"])
    expect(migrationPrefix("20261018-0110-x.sql")).toBe("20261018-0110")
  })
})

describe("every real migration after the lock keeps new tables locked", () => {
  const dir = path.join(process.cwd(), "scripts", "migrations")
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql"))
  it("the migrations folder is readable and has files", () => expect(files.length).toBeGreaterThan(50))
  it("no migration newer than 20261018-0110 creates a table without the lock", () => {
    const bad: string[] = []
    for (const f of files) {
      const problems = lockViolations(f, fs.readFileSync(path.join(dir, f), "utf8"))
      for (const p of problems) bad.push(`${f}: ${p}`)
    }
    expect(bad).toEqual([])
  })
})
