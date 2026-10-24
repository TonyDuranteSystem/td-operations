import { describe, it, expect } from "vitest"
import { availableBoardRoles, boardRole, resolveBoardRole } from "@/lib/marketing/board"
import { romeLocalToIso } from "@/lib/marketing/rome-time"
import { checkSend, folderFor, URL_CACHE_SECONDS, URL_REFRESH_SECONDS, SIGNED_URL_SECONDS } from "@/lib/marketing/lead-chat"
import { STATIC_SNIPPETS } from "@/components/talk/talk-i18n"
import { windowSrc, openWindow, EMPTY_WINDOWS } from "@/lib/marketing/lead-windows"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { effectivePermissions, MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"

const TEAM = "11111111-1111-4111-8111-111111111111"
const LEAD = "22222222-2222-4222-8222-222222222222"
const OBJ = "33333333-3333-4333-8333-333333333333"
const bundles = MARKETING_SETTING_DEFS.permission_bundles.fallback

describe("which board a person gets (a role is read from what he can do, not from a money permission)", () => {
  const perms = (bundle: string) => effectivePermissions({ memberRole: "member", bundle, bundles })
  it("the seller bundle (no payment-link permission) gets the seller's board; the setter bundle the setter's", () => {
    expect(perms("seller")).not.toContain("payment_links.create")
    expect(boardRole(perms("seller"))).toBe("seller")
    expect(boardRole(perms("setter"))).toBe("setter")
    expect(availableBoardRoles(perms("seller"))).toEqual(["seller"])
    expect(availableBoardRoles(perms("setter"))).toEqual(["setter"])
  })
  it("the team owner holds everything: both boards, the seller's first, and he can ask for the setter's", () => {
    const owner = effectivePermissions({ memberRole: "owner", bundles })
    expect(availableBoardRoles(owner)).toEqual(["seller", "setter"])
    expect(boardRole(owner)).toBe("seller")
    expect(resolveBoardRole(owner, "setter")).toBe("setter")
  })
  it("a request for a board a person may not use is ignored; anyone with no role still gets a board", () => {
    expect(resolveBoardRole(effectivePermissions({ memberRole: "member", bundle: "setter", bundles }), "seller")).toBe("setter")
    expect(resolveBoardRole(["leads.read"], "seller")).toBe("setter")
    expect(resolveBoardRole([], "garbage")).toBe("setter")
    expect(MARKETING_PERMISSIONS.length).toBeGreaterThan(10)
  })
})

describe("a day and time typed in a date field is Rome time, whatever the computer's zone", () => {
  it("winter (UTC+1) and summer (UTC+2), and the days the clocks change", () => {
    expect(romeLocalToIso("2026-12-15T11:00")).toBe("2026-12-15T10:00:00.000Z")
    expect(romeLocalToIso("2026-07-15T11:00")).toBe("2026-07-15T09:00:00.000Z")
    expect(romeLocalToIso("2026-10-25T12:00")).toBe("2026-10-25T11:00:00.000Z") // after the clocks went back (25 Oct 2026)
    expect(romeLocalToIso("2026-10-24T12:00")).toBe("2026-10-24T10:00:00.000Z") // the day before: still summer time
    expect(romeLocalToIso("2026-03-29T12:00")).toBe("2026-03-29T10:00:00.000Z") // after the clocks went forward
  })
  it("anything that is not a date-time is refused", () => {
    for (const bad of ["", "tomorrow", "2026-13-40T99:99", "2026-10-25", "2026-10-25 11:00"]) expect(romeLocalToIso(bad), bad).toBeNull()
  })
})

describe("files in the chat follow TD Talk's policy", () => {
  const att = (name: string, mime: string, size = 1000) => ({ path: `${folderFor(TEAM, LEAD)}${OBJ}.bin`, name, mime_type: mime, size })
  const send = (a: ReturnType<typeof att>) => checkSend({ message: "", attachments: [a], teamId: TEAM, leadId: LEAD })
  it("a video, a Word 97 file, an Excel 97 file and a photo with no type are accepted", () => {
    expect(send(att("clip.mov", "video/quicktime"))).toMatchObject({ ok: true })
    expect(send(att("costi.doc", "application/msword"))).toMatchObject({ ok: true })
    expect(send(att("lista.xls", "application/vnd.ms-excel"))).toMatchObject({ ok: true })
    expect(send(att("IMG_0001.HEIC", ""))).toMatchObject({ ok: true })
  })
  it("an executable or active content is refused on the server, whatever the browser said", () => {
    expect(send(att("setup.exe", "application/x-msdownload"))).toMatchObject({ ok: false })
    expect(send(att("page.html", "text/html"))).toMatchObject({ ok: false })
    expect(send(att("run.sh", ""))).toMatchObject({ ok: false })
  })
  it("a file over the limit is refused", () => {
    expect(send(att("big.pdf", "application/pdf", 101 * 1024 * 1024))).toMatchObject({ ok: false })
  })
})

describe("file links never run out while a window is open", () => {
  it("a link handed out at the end of its cache time is still good when the open window asks for fresh ones", () => {
    expect(URL_CACHE_SECONDS + URL_REFRESH_SECONDS).toBeLessThan(SIGNED_URL_SECONDS)
  })
})

describe("only the screen's own fixed lines are translated, never what a person wrote", () => {
  it("the fixed lines are exactly the ones the chat model writes for a message without words", () => {
    expect(Array.from(STATIC_SNIPPETS).sort()).toEqual(["Message", "Message deleted", "📷 Photo", "🎤 Voice message"].sort())
    expect(STATIC_SNIPPETS.has("Delete")).toBe(false)
    expect(STATIC_SNIPPETS.has("Today")).toBe(false)
  })
})

describe("a window opened again does not reload", () => {
  const vp = { w: 1440, h: 900 }
  const lead = { id: LEAD, name: "A" }
  it("the page a window was opened on never changes, even when the tab asked for later does", () => {
    let s = openWindow(EMPTY_WINDOWS, lead, vp)
    s = openWindow(s, { ...lead, tab: "chat" }, vp)
    expect(s.list[0]).toMatchObject({ tab: "chat", srcTab: "lead" })
  })
  it("the address carries the board the person is on, only a real one", () => {
    expect(windowSrc(LEAD, "lead", "setter")).toBe(`/marketing/window/${LEAD}?role=setter`)
    expect(windowSrc(LEAD, "chat", "seller")).toBe(`/marketing/window/${LEAD}?tab=chat&role=seller`)
    expect(windowSrc(LEAD, "lead", "evil")).toBe(`/marketing/window/${LEAD}`)
  })
})
