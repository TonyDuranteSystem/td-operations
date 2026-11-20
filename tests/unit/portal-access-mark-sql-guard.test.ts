/**
 * Guard for the database half of the member "no portal access" mark (dev job beb43385, delivery C part 2).
 *
 * The migration 20261120-0700 teaches three read policies and the two staff chat functions to leave out a link that carries
 * the mark (account_contacts.access_revoked_at). This test reads the SQL file and fails when any read of account_contacts in it
 * loses that condition, and checks the undo file puts the old definitions back (no mark condition anywhere).
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const DIR = path.resolve(__dirname, "..", "..", "scripts", "migrations")
const UP = fs.readFileSync(path.join(DIR, "20261120-0700-portal-access-mark-in-remaining-database-rules.sql"), "utf8")
const UNDO = fs.readFileSync(path.join(DIR, "20261120-0700-portal-access-mark-in-remaining-database-rules.UNDO.sql"), "utf8")

const READ = /(FROM|JOIN)\s+account_contacts\b/i

/** The SQL without its comment lines (the file explains itself in comments that also name account_contacts). */
function code(sql: string): string[] {
  return sql.split("\n").filter((l) => !/^\s*--/.test(l))
}

describe("portal access mark — remaining database rules", () => {
  it("every read of account_contacts in the migration carries the no-access condition within a few lines", () => {
    const lines = code(UP)
    const reads: number[] = []
    lines.forEach((l, i) => { if (READ.test(l)) reads.push(i) })
    // 3 policies (annual agreements, SS-4, members) + threads_v2 (CTE, members list, companies list, 2 company-only reads) + thread keys (CTE, company-only read)
    expect(reads.length).toBe(10)
    const offenders = reads.filter((i) => !lines.slice(i, i + 5).join("\n").includes("access_revoked_at"))
    expect(offenders.map((i) => lines[i].trim())).toEqual([])
  })

  it("the three policies and the two functions are all in the file", () => {
    for (const name of ["client_read_own", "clients_read_own_ss4", "members_portal_read", "get_portal_chat_threads_v2", "get_portal_chat_people_thread_keys"]) {
      expect(UP).toContain(name)
    }
  })

  it("policies that do not exist (the sandbox lacks two) are skipped, not failed", () => {
    expect((UP.match(/IF EXISTS \(SELECT 1 FROM pg_policies/g) ?? []).length).toBe(3)
  })

  it("the undo file puts the old definitions back: no mark condition anywhere, same five objects", () => {
    expect(code(UNDO).join("\n")).not.toContain("access_revoked_at")
    for (const name of ["client_read_own", "clients_read_own_ss4", "members_portal_read", "get_portal_chat_threads_v2", "get_portal_chat_people_thread_keys"]) {
      expect(UNDO).toContain(name)
    }
  })

  it("the SS-4 policy keeps its first branch (this SS-4 is MINE, by contact id) exactly as it was", () => {
    expect(UP).toContain("contact_id = ((auth.jwt() ->> 'contact_id'::text))::uuid)\n        OR (account_id IN (")
    expect(UNDO).toContain("contact_id = ((auth.jwt() ->> 'contact_id'::text))::uuid)\n        OR (account_id IN (")
  })
})
