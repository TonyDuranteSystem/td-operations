import { describe, it, expect } from "vitest"
import { inheritMembersMaySign } from "@/lib/portal/oa-regenerate-guard"

describe("inheritMembersMaySign — a replaced draft keeps 'each Member may also sign'", () => {
  it("no agreements → off", () => {
    expect(inheritMembersMaySign([])).toBe(false)
  })
  it("the newest unsigned draft with the setting on → on", () => {
    expect(inheritMembersMaySign([{ status: "draft", members_may_sign: true }])).toBe(true)
    expect(inheritMembersMaySign([{ status: "sent", members_may_sign: true }])).toBe(true)
    expect(inheritMembersMaySign([{ status: "viewed", members_may_sign: true }])).toBe(true)
  })
  it("an unsigned draft with the setting off or unreadable → off", () => {
    expect(inheritMembersMaySign([{ status: "draft", members_may_sign: false }])).toBe(false)
    expect(inheritMembersMaySign([{ status: "draft", members_may_sign: null }])).toBe(false)
    expect(inheritMembersMaySign([{ status: "draft" }])).toBe(false)
  })
  it("a signed agreement never decides (its wording is its own)", () => {
    expect(inheritMembersMaySign([{ status: "signed", members_may_sign: true }])).toBe(false)
  })
  it("a voided or ever-signed row never decides", () => {
    expect(inheritMembersMaySign([{ status: "voided", members_may_sign: true }])).toBe(false)
    expect(inheritMembersMaySign([{ status: "draft", signed_at: "2026-05-10T07:46:31Z", members_may_sign: true }])).toBe(false)
  })
  it("skips finished rows and reads the newest draft (newest first)", () => {
    expect(inheritMembersMaySign([
      { status: "signed", members_may_sign: false },
      { status: "draft", members_may_sign: true },
    ])).toBe(true)
    // the NEWEST draft decides, an older one does not
    expect(inheritMembersMaySign([
      { status: "draft", members_may_sign: false },
      { status: "draft", members_may_sign: true },
    ])).toBe(false)
  })
  it("Beril LLC shape: an old voided signed single-member agreement + the new draft on", () => {
    expect(inheritMembersMaySign([
      { status: "draft", signed_at: null, members_may_sign: true },
      { status: "voided", signed_at: "2026-05-10T07:46:31Z", members_may_sign: false },
    ])).toBe(true)
  })
})
