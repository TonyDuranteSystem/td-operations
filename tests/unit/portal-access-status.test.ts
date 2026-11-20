import { describe, it, expect } from "vitest"
import { portalAccessChip, staffAccessButtons, PORTAL_ACCESS_CHIP_TEXT } from "@/lib/members/portal-access-status"

describe("portalAccessChip", () => {
  it("a marked link always reads as no portal access, even when the person has a login for another company", () => {
    expect(portalAccessChip({ marked: true, hasLogin: true, accountTier: "active" })).toBe("no_portal_access")
    expect(portalAccessChip({ marked: true, hasLogin: false, accountTier: "formation" })).toBe("no_portal_access")
  })

  it("not marked with a login: login active", () => {
    expect(portalAccessChip({ marked: false, hasLogin: true, accountTier: "formation" })).toBe("login_active")
    expect(portalAccessChip({ marked: false, hasLogin: true, accountTier: "active" })).toBe("login_active")
  })

  it("not marked, no login, company still being formed: the login comes after the EIN", () => {
    expect(portalAccessChip({ marked: false, hasLogin: false, accountTier: "formation" })).toBe("login_after_ein")
  })

  it("not marked, no login, company past formation (or unknown tier): no login yet", () => {
    expect(portalAccessChip({ marked: false, hasLogin: false, accountTier: "active" })).toBe("no_login_yet")
    expect(portalAccessChip({ marked: false, hasLogin: false, accountTier: "onboarding" })).toBe("no_login_yet")
    expect(portalAccessChip({ marked: false, hasLogin: false, accountTier: null })).toBe("no_login_yet")
  })

  it("every chip has a label and a hint in plain words", () => {
    for (const key of ["no_portal_access", "login_active", "login_after_ein", "no_login_yet"] as const) {
      expect(PORTAL_ACCESS_CHIP_TEXT[key].label.length).toBeGreaterThan(3)
      expect(PORTAL_ACCESS_CHIP_TEXT[key].hint.length).toBeGreaterThan(10)
    }
    expect(PORTAL_ACCESS_CHIP_TEXT.no_portal_access.label).toBe("No portal access")
    expect(PORTAL_ACCESS_CHIP_TEXT.login_active.label).toBe("Portal login active")
    expect(PORTAL_ACCESS_CHIP_TEXT.login_after_ein.label).toBe("Login after EIN")
  })
})

describe("staffAccessButtons", () => {
  it("a marked person can be given access, not taken away again", () => {
    expect(staffAccessButtons({ marked: true, openLinkCount: 2 })).toEqual({ takeAway: false, give: true, takeAwayBlockedReason: null })
  })

  it("an open person can be taken away when someone else keeps access", () => {
    expect(staffAccessButtons({ marked: false, openLinkCount: 2 })).toEqual({ takeAway: true, give: false, takeAwayBlockedReason: null })
  })

  it("the last person with access cannot be taken away, and the reason is shown", () => {
    const b = staffAccessButtons({ marked: false, openLinkCount: 1 })
    expect(b.takeAway).toBe(false)
    expect(b.give).toBe(false)
    expect(b.takeAwayBlockedReason).toMatch(/someone must keep/i)
  })
})
