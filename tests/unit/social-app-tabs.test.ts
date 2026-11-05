/**
 * TD Social — the tab list (dev job 2072bc3e, Step 2 pull request A). Every kind of login, the two mailboxes, and the proof that a sixth
 * tab is ONE new entry (the "flexible, not hard-coded" requirement).
 */
import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))

import { TAB_LIST, tabsFor, loginKind, type AppIdentity, type TabEntry } from "@/lib/app/tabs"

const who = (o: Partial<AppIdentity>): AppIdentity => ({ authRole: "", isAdmin: false, isStaff: false, marketingChat: false, ...o })
const ids = (i: AppIdentity) => tabsFor(i).map(t => t.id)

const admin = who({ authRole: "admin", isAdmin: true, isStaff: true })
const team = who({ authRole: "team", isStaff: true })
const marketing = who({ authRole: "marketing", marketingChat: true })

describe("tabsFor: who sees which tab", () => {
  it("an admin who is NOT in a Marketing team sees four tabs, Inbox with both mailboxes", () => {
    expect(ids(admin)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(tabsFor(admin).find(t => t.id === "inbox")?.mailboxes).toEqual(["support", "antonio"])
  })

  it("an admin who is an active Marketing member with chat sees all five", () => {
    expect(ids({ ...admin, marketingChat: true })).toEqual(["talk", "portal", "whatsapp", "inbox", "marketing"])
  })

  it("a staff 'team' login sees four tabs and ONLY the support mailbox", () => {
    expect(ids(team)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(tabsFor(team).find(t => t.id === "inbox")?.mailboxes).toEqual(["support"])
  })

  it("a staff 'team' login NEVER gets Marketing, even if the Marketing lookup said yes", () => {
    expect(ids({ ...team, marketingChat: true })).not.toContain("marketing")
  })

  it("a marketing login sees Marketing and nothing else", () => {
    expect(ids(marketing)).toEqual(["marketing"])
  })

  it("a marketing login without the chat permission has no tab at all", () => {
    expect(ids({ ...marketing, marketingChat: false })).toEqual([])
  })

  it("a client, a partner, an unknown role and an empty role have no tab", () => {
    for (const authRole of ["client", "partner", "contractor", ""]) expect(ids(who({ authRole }))).toEqual([])
  })

  it("only the Inbox carries mailboxes", () => {
    for (const t of tabsFor({ ...admin, marketingChat: true })) {
      expect("mailboxes" in t).toBe(t.id === "inbox")
    }
  })

  it("keeps the list order the app shows", () => {
    expect(TAB_LIST.map(t => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox", "marketing"])
  })
})

describe("loginKind", () => {
  it("names the three kinds", () => {
    expect(loginKind(admin)).toBe("staff")
    expect(loginKind(team)).toBe("staff")
    expect(loginKind(marketing)).toBe("marketing")
    expect(loginKind(who({ authRole: "client" }))).toBe("none")
  })
})

describe("a sixth tab is ONE new entry", () => {
  it("adding an entry to the list is all it takes, and it follows the same rules", () => {
    const sixth: TabEntry<string> = { id: "calendar", label: "Calendar", allowed: w => w.isAdmin }
    const list = [...(TAB_LIST as readonly TabEntry<string>[]), sixth]
    expect(tabsFor(admin, list).map(t => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox", "calendar"])
    expect(tabsFor(team, list).map(t => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(tabsFor(who({ authRole: "client" }), list)).toEqual([])
  })
})
