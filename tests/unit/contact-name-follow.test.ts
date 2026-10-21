import { describe, it, expect } from "vitest"
import { nameKey, planMemberRenames } from "@/lib/operations/contact-name-follow"
import { sharedMemberAccounts, plainReference } from "@/lib/operations/contact-merge-preview"

const row = (id: string, name: string | null, account = "a1") => ({ id, account_id: account, full_name: name, ownership_pct: 50 })

describe("nameKey", () => {
  it("ignores case and spacing only", () => {
    expect(nameKey("  Chiara   Vita ")).toBe("chiara vita")
    expect(nameKey(null)).toBe("")
  })
})

describe("planMemberRenames", () => {
  it("edit: renames only owner records that carried the previous contact name", () => {
    const rows = [row("m1", "GRAZIELLA CHAIRA"), row("m2", "Peter Marton Nemeskeri", "a2")]
    const plan = planMemberRenames(rows, "GRAZIELLA CHIARA", "graziella  chaira")
    expect(plan.map((p) => [p.id, p.newName])).toEqual([["m1", "GRAZIELLA CHIARA"]])
  })
  it("edit: a legal name that differs on purpose is left alone", () => {
    expect(planMemberRenames([row("m1", "Nemeskeri Peter Marton")], "Peter Nemeskeri", "Peter Marton Nemeskeri")).toEqual([])
  })
  it("merge (no previous name): every given row takes the kept name, unless already equal", () => {
    const plan = planMemberRenames([row("m1", "GRAZIELLA CHAIRA"), row("m2", "grazielLA chiara")], "GRAZIELLA CHIARA")
    expect(plan.map((p) => p.id)).toEqual(["m1"])
  })
  it("never writes a blank name", () => {
    expect(planMemberRenames([row("m1", "X")], "   ")).toEqual([])
    expect(planMemberRenames([row("m1", "X")], null)).toEqual([])
  })
  it("edit with an unreadable previous name (null) only touches rows with no name", () => {
    expect(planMemberRenames([row("m1", "X"), row("m2", null)], "New Name", null).map((p) => p.id)).toEqual(["m2"])
  })
})

describe("sharedMemberAccounts", () => {
  it("finds companies where both contacts are owners", () => {
    expect(sharedMemberAccounts([{ account_id: "a" }, { account_id: "b" }], [{ account_id: "b" }, { account_id: "c" }])).toEqual(["b"])
    expect(sharedMemberAccounts([{ account_id: "a" }], [{ account_id: "b" }])).toEqual([])
  })
})

describe("plainReference", () => {
  it("turns a table.column key into plain words", () => {
    expect(plainReference("email_index.contact_id")).toBe("email index")
    expect(plainReference("portal_messages.addressed_to_contact_id")).toBe("portal messages")
  })
})
