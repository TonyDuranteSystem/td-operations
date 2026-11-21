/**
 * The other doors out of a company (Unlink, old Revoke access, delete contact) never leave a company with only people who carry
 * the "no portal access" mark (dev job beb43385, QA 21 Nov 2026). Narrow: a company with no marked people is untouched.
 */
import { describe, expect, it } from "vitest"
import { removalLeavesOnlyMarkedPeople, type RosterLink } from "@/lib/members/removal-guard"

const open = (id: string): RosterLink => ({ contact_id: id, access_revoked_at: null })
const marked = (id: string): RosterLink => ({ contact_id: id, access_revoked_at: "2026-11-01T00:00:00Z" })

describe("removalLeavesOnlyMarkedPeople", () => {
  it("refuses the last open person while someone marked would remain", () => {
    expect(removalLeavesOnlyMarkedPeople([open("a"), marked("b")], "a")).toBe(true)
    expect(removalLeavesOnlyMarkedPeople([open("a"), marked("b"), marked("c")], "a")).toBe(true)
  })

  it("lets an open person go while another open person remains", () => {
    expect(removalLeavesOnlyMarkedPeople([open("a"), open("b"), marked("c")], "a")).toBe(false)
  })

  it("a company with no marked people is untouched, even for its only person", () => {
    expect(removalLeavesOnlyMarkedPeople([open("a")], "a")).toBe(false)
    expect(removalLeavesOnlyMarkedPeople([open("a"), open("b")], "a")).toBe(false)
  })

  it("removing a person who is already marked takes no access away", () => {
    expect(removalLeavesOnlyMarkedPeople([open("a"), marked("b")], "b")).toBe(false)
  })

  it("a person who is not linked is not a problem", () => {
    expect(removalLeavesOnlyMarkedPeople([open("a"), marked("b")], "zzz")).toBe(false)
  })
})
