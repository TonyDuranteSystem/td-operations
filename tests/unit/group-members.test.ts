import { describe, it, expect } from "vitest"
import { normalizeMembers, parseGroupsBatch } from "@/lib/messaging/wabridge-groups"
import { matchMembersToCrm, phoneSearchTail } from "@/lib/messaging/group-members"

describe("normalizeMembers", () => {
  it("keeps good members, hides bad numbers, drops repeats and empty rows", () => {
    const r = normalizeMembers([
      { phone: "17275893417", name: " Tony ", admin: true },
      { phone: "17275893417", name: "dup" },
      { phone: "123", name: "Short number" },
      { phone: null, name: "Hidden" },
      { phone: null, name: "" },
      "junk",
    ])
    expect(r).toEqual([
      { phone: "17275893417", name: "Tony", admin: true },
      { phone: null, name: "Short number", admin: false },
      { phone: null, name: "Hidden", admin: false },
    ])
  })
  it("returns undefined when no list was reported", () => {
    expect(normalizeMembers(undefined)).toBeUndefined()
    expect(normalizeMembers("x")).toBeUndefined()
  })
  it("caps a huge list", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ phone: String(10000000 + i), name: "x" }))
    expect(normalizeMembers(many)?.length).toBe(300)
  })
})

describe("parseGroupsBatch with members", () => {
  const now = new Date("2026-11-20T10:00:00Z")
  it("carries members through, and leaves them out when the Mac did not send them", () => {
    const r = parseGroupsBatch({ ts: now.getTime(), groups: [
      { jid: "120363432541591903@g.us", name: "A", members: [{ phone: "393339980702", name: "Mario", admin: false }] },
      { jid: "120363430864874174@g.us", name: "B" },
    ] }, now)
    expect("groups" in r && r.groups[0].members).toEqual([{ phone: "393339980702", name: "Mario", admin: false }])
    expect("groups" in r && "members" in r.groups[1]).toBe(false)
  })
})

describe("matchMembersToCrm", () => {
  const members = [{ phone: "17275893417", name: "Tony", admin: false }, { phone: "393339980702", name: "Mario", admin: false }, { phone: null, name: "Hidden", admin: false }]
  it("matches on the FULL number even when the CRM number is formatted", () => {
    const r = matchMembersToCrm(members, [{ id: "c1", full_name: "Tony Durante", phone: "+1 (727) 589-3417" }], [])
    expect(r[0].crm).toEqual({ kind: "contact", id: "c1", name: "Tony Durante" })
    expect(r[1].crm).toBeNull()
    expect(r[2].crm).toBeNull()
  })
  it("does not match on the last digits alone", () => {
    const r = matchMembersToCrm(members, [{ id: "c2", full_name: "Other", phone: "+44 7000 589 3417" }], [])
    expect(r[0].crm).toBeNull()
  })
  it("two different records with the same number = no guess", () => {
    const r = matchMembersToCrm(members, [{ id: "c1", full_name: "A", phone: "17275893417" }, { id: "c2", full_name: "B", phone: "17275893417" }], [])
    expect(r[0].crm).toBeNull()
  })
  it("offers a lead only when no contact holds the number", () => {
    const lead = [{ id: "l1", full_name: "Lead Person", phone: "393339980702" }]
    expect(matchMembersToCrm(members, [], lead)[1].crm).toEqual({ kind: "lead", id: "l1", name: "Lead Person" })
    expect(matchMembersToCrm(members, [{ id: "c9", full_name: "Real", phone: "393339980702" }], lead)[1].crm?.kind).toBe("contact")
  })
  it("search tail is the last 4 digits", () => {
    expect(phoneSearchTail("+1 727 589 3417")).toBe("3417")
  })
})
