/**
 * The hardened lock check (Booking page, Stage 1a): from migration 20261113-1700 on, a created table needs row-level security ON *and*
 * REVOKE ALL ... FROM anon, authenticated — not only the marketing_lock_all_tables() line (which on its own leaves a table with RLS off readable by any logged-in token).
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { lockViolations, STRICT_LOCK_FROM } from "@/lib/security/migration-lock-check"

const NEW = "20261113-1800-example.sql"
const LOCK = "SELECT public.marketing_lock_all_tables();"
const RLS = (t: string) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`
const REVOKE = (t: string) => `REVOKE ALL ON public.${t} FROM anon, authenticated;`
const table = (t: string) => `CREATE TABLE IF NOT EXISTS public.${t} (id uuid);`

describe("strict lock rule (new migrations only)", () => {
  it("the lock call alone is NOT enough any more", () => {
    const v = lockViolations(NEW, `${table("things")}\n${LOCK}`)
    expect(v).toHaveLength(2)
    expect(v.join(" ")).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(v.join(" ")).toMatch(/REVOKE ALL/)
  })
  it("RLS + REVOKE + lock call passes", () => {
    expect(lockViolations(NEW, `${table("things")}\n${RLS("things")}\n${REVOKE("things")}\n${LOCK}`)).toEqual([])
  })
  it("RLS without the REVOKE fails; the REVOKE without RLS fails", () => {
    expect(lockViolations(NEW, `${table("things")}\n${RLS("things")}\n${LOCK}`)).toHaveLength(1)
    expect(lockViolations(NEW, `${table("things")}\n${REVOKE("things")}\n${LOCK}`)).toHaveLength(1)
  })
  it("the REVOKE must name BOTH roles", () => {
    expect(lockViolations(NEW, `${table("things")}\n${RLS("things")}\nREVOKE ALL ON public.things FROM anon;\n${LOCK}`)).toHaveLength(1)
    expect(lockViolations(NEW, `${table("things")}\n${RLS("things")}\nREVOKE ALL ON public.things FROM authenticated;\n${LOCK}`)).toHaveLength(1)
    expect(lockViolations(NEW, `${table("things")}\n${RLS("things")}\nREVOKE ALL ON TABLE things FROM authenticated, anon;\n${LOCK}`)).toEqual([])
  })
  it("a REVOKE for ANOTHER table does not count", () => {
    expect(lockViolations(NEW, `${table("a")}\n${table("b")}\n${RLS("a")}\n${RLS("b")}\n${REVOKE("a")}\n${LOCK}`)).toHaveLength(1)
  })
  it("every table in the file needs both lines", () => {
    expect(lockViolations(NEW, `${table("a")}\n${table("b")}\n${RLS("a")}\n${REVOKE("a")}\n${LOCK}`)).toHaveLength(2)
    expect(lockViolations(NEW, `${table("a")}\n${table("b")}\n${RLS("a")}\n${RLS("b")}\n${REVOKE("a")}\n${REVOKE("b")}\n${LOCK}`)).toEqual([])
  })
  it("lines that exist only in a comment do not count", () => {
    expect(lockViolations(NEW, `${table("things")}\n-- ${RLS("things")}\n/* ${REVOKE("things")} */\n${LOCK}`)).toHaveLength(2)
  })
  it("a marketing_ table still needs its own RLS line, as before", () => {
    expect(lockViolations(NEW, `${table("marketing_x")}\n${RLS("marketing_x")}\n${REVOKE("marketing_x")}`)).toEqual([])
    expect(lockViolations(NEW, `${table("marketing_x")}\n${REVOKE("marketing_x")}`).length).toBeGreaterThan(0)
  })
  it("older migrations are not held to the strict rule (several predate it and are never edited)", () => {
    expect(lockViolations("20261105-0900-old.sql", `${table("things")}\n${LOCK}`)).toEqual([])
    expect(lockViolations("20261113-1659-old.sql", `${table("things")}\n${LOCK}`)).toEqual([])
    expect(STRICT_LOCK_FROM).toBe("20261113-1700")
  })
  it("UNDO files and migrations without a table are not checked", () => {
    expect(lockViolations("20261113-1800-example.UNDO.sql", table("things"))).toEqual([])
    expect(lockViolations(NEW, "ALTER TABLE accounts ADD COLUMN x int;")).toEqual([])
  })
})

describe("the four Booking migrations really carry both lines", () => {
  const dir = path.join(process.cwd(), "scripts", "migrations")
  const files = fs.readdirSync(dir).filter((f) => /^20261113-17[1-4]0-.*\.sql$/.test(f) && !f.endsWith(".UNDO.sql"))
  it("finds the four files", () => expect(files.sort()).toEqual(["20261113-1710-booking-kinds-catalog.sql", "20261113-1720-booking-links.sql", "20261113-1730-call-checks.sql", "20261113-1740-contact-calls.sql"]))
  it("none of them fails the strict check", () => {
    for (const f of files) expect(lockViolations(f, fs.readFileSync(path.join(dir, f), "utf8"))).toEqual([])
  })
  it("every migration from the strict date on passes (so the next one cannot forget)", () => {
    const bad: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      for (const p of lockViolations(f, fs.readFileSync(path.join(dir, f), "utf8"))) bad.push(`${f}: ${p}`)
    }
    expect(bad).toEqual([])
  })
  it("each UNDO is a plain DROP TABLE (no CASCADE: a wrong order must fail, not silently drop the neighbours)", () => {
    for (const f of ["20261113-1720-booking-links", "20261113-1730-call-checks", "20261113-1740-contact-calls"]) {
      const sql = fs.readFileSync(path.join(dir, `${f}.UNDO.sql`), "utf8")
      expect(sql).toMatch(/DROP TABLE IF EXISTS public\.[a-z_]+;/)
      expect(sql).not.toMatch(/CASCADE/i)
    }
  })
  it("every created table has real foreign keys, never a CHECK list (a CHECK on the shared sandbox turns other sessions' CI red)", () => {
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), "utf8")).not.toMatch(/\bCHECK\s*\(/i)
  })
})
