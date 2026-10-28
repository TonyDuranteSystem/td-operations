import { describe, expect, it } from "vitest"
import { frameFor } from "@/lib/marketing/frame"
import { OWNER_MENU } from "@/lib/marketing/owner-menu"

describe("which frame a Marketing screen is shown in (Antonio, 28 Oct 2026 — it was flipped twice, so the rule is pinned)", () => {
  it("Antonio on his own login always gets HIS frame (his menu on every screen, never Rocco's)", () => {
    expect(frameFor({ admin: true, viewAs: false })).toBe("owner")
  })
  it("'View as' shows the team's frame (it is a preview of what that person sees)", () => {
    expect(frameFor({ admin: true, viewAs: true })).toBe("team")
  })
  it("Rocco, Ale and everybody else get the team's frame", () => {
    expect(frameFor({ admin: false, viewAs: false })).toBe("team")
    expect(frameFor({ admin: false, viewAs: true })).toBe("team")
  })
  it("every team screen on his menu is reachable from his frame (Messages, Board, Calendar, Documents, Templates)", () => {
    const hrefs = OWNER_MENU.flatMap(i => [i.href, ...(i.children ?? []).map(c => c.href)])
    for (const h of ["/marketing/board", "/marketing/calendar", "/marketing/chat", "/marketing/inbox", "/marketing/whatsapp", "/marketing/documents", "/marketing/templates"]) expect(hrefs).toContain(h)
  })
})

import { readFileSync } from "node:fs"

describe("the layout really uses the rule (a pure function alone would not catch a wiring mistake)", () => {
  const layout = readFileSync("app/marketing/(app)/layout.tsx", "utf8")
  it("asks frameFor, with the admin check and the View-as flag", () => {
    expect(layout).toMatch(/frameFor\(\{ admin: fromCrm, viewAs: !!ctx\.viewAs \}\) === 'owner'/)
  })
  it("his menu replaces the team's menu only in his frame, and the team's tour never starts there", () => {
    expect(layout).toMatch(/ownerLogin \? <OwnerNav badges=\{\{ messages: chatUnread, news: drafts \}\} \/> : <WorkspaceNav items=\{nav\} \/>/)
    expect(layout).toMatch(/const autoStart = !ctx\.viewAs && !ownerLogin &&/)
    expect(layout).toMatch(/\{ownerLogin \? 'Owner' : ctx\.team\.name\}/)
  })
})
