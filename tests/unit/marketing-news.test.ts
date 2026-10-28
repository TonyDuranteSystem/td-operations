import { describe, expect, it } from "vitest"
import {
  ANNOUNCEMENTS, BASELINE_SCREENS, audienceMatches, hrefForLink, linkTargets, newsText, pendingAnnouncements, readSummary, screensWithoutAnnouncementDecision, validateNews,
} from "@/lib/marketing/news"
import { OWNER_MENU, activeOwnerItem } from "@/lib/marketing/owner-menu"
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { modulesFor } from "@/lib/marketing/workspace"

const SELLER = ["leads.pick", "leads.read", "chat"]
const SETTER = ["leads.worklist", "leads.mark", "chat"]

describe("What's New — who a post is for", () => {
  it("everyone reaches everyone; sellers are the people who may pick leads; setters work the list but may not pick", () => {
    expect(audienceMatches("everyone", SETTER)).toBe(true)
    expect(audienceMatches("sellers", SELLER)).toBe(true)
    expect(audienceMatches("sellers", SETTER)).toBe(false)
    expect(audienceMatches("setters", SETTER)).toBe(true)
    expect(audienceMatches("setters", SELLER)).toBe(false)
  })
  it("Antonio, who holds every permission, counts as a seller and not as a setter", () => {
    expect(audienceMatches("sellers", MARKETING_PERMISSIONS)).toBe(true)
    expect(audienceMatches("setters", MARKETING_PERMISSIONS)).toBe(false)
  })
  it("an unknown audience is never a secret: it falls back to everyone only through validateNews, never here silently", () => {
    expect(validateNews({ title: "a", body: "b", audience: "ceo" }).ok).toBe(false)
  })
})

describe("What's New — what Antonio typed", () => {
  const ok = { title: "Documents is live", body: "Find it in the menu.", linkKey: "documents" }
  it("accepts a title and a text, defaults the audience to everyone and trims", () => {
    const r = validateNews({ ...ok, title: "  Documents is live  " })
    expect(r).toEqual({ ok: true, value: { title: "Documents is live", body: "Find it in the menu.", titleIt: null, bodyIt: null, linkKey: "documents", audience: "everyone" } })
  })
  it("refuses an empty title or text, a too-long text and a screen that does not exist", () => {
    expect(validateNews({ ...ok, title: " " })).toMatchObject({ ok: false })
    expect(validateNews({ ...ok, body: "" })).toMatchObject({ ok: false })
    expect(validateNews({ ...ok, body: "x".repeat(2001) })).toMatchObject({ ok: false })
    expect(validateNews({ ...ok, linkKey: "nope" })).toMatchObject({ ok: false, error: "That screen does not exist." })
  })
  it("refuses a half-filled Italian pair so a title never shows without its text", () => {
    expect(validateNews({ ...ok, titleIt: "Documenti" })).toMatchObject({ ok: false })
    expect(validateNews({ ...ok, titleIt: "Documenti", bodyIt: "Nel menu." })).toMatchObject({ ok: true })
  })
  it("the team reads Italian when it exists and the person works in Italian, otherwise English", () => {
    const n = { title: "T", body: "B", title_it: "TI", body_it: "BI" }
    expect(newsText(n, "it")).toEqual({ title: "TI", body: "BI" })
    expect(newsText(n, "en")).toEqual({ title: "T", body: "B" })
    expect(newsText({ ...n, title_it: null, body_it: null }, "it")).toEqual({ title: "T", body: "B" })
  })
})

describe("What's New — drafts for new screens", () => {
  it("Documents waits as a draft until Antonio decides it (approved or discarded), then never comes back", () => {
    expect(pendingAnnouncements(new Set()).map(a => a.key)).toContain("documents")
    expect(pendingAnnouncements(new Set(["documents"])).map(a => a.key)).not.toContain("documents")
  })
  it("every draft is a valid post, with its Italian, linking to a real screen", () => {
    for (const a of ANNOUNCEMENTS) {
      expect(validateNews({ title: a.title, body: a.body, titleIt: a.titleIt, bodyIt: a.bodyIt, linkKey: a.menuKey, audience: a.audience }).ok, a.key).toBe(true)
      expect(hrefForLink(a.menuKey), a.key).toBeTruthy()
    }
  })
  it("a screen can never go live without Antonio being asked: every menu screen is old (baseline) or has a draft", () => {
    expect(screensWithoutAnnouncementDecision()).toEqual([])
  })
  it("the baseline list holds only screens that exist (a removed screen is taken off it)", () => {
    const keys = new Set(modulesFor(MARKETING_PERMISSIONS).map(m => m.key))
    expect(BASELINE_SCREENS.filter(k => !keys.has(k))).toEqual([])
  })
  it("a post links only to a screen that is built", () => {
    expect(linkTargets().every(t => t.href.startsWith("/marketing/"))).toBe(true)
    expect(hrefForLink(null)).toBeNull()
    expect(hrefForLink("calls")).toBeNull()
  })
})

describe("What's New — who has read it", () => {
  it("counts readers among the people it was for and names the ones who have not", () => {
    const rec = [{ id: "a", name: "Rocco" }, { id: "b", name: "Ale" }]
    expect(readSummary(rec, new Set(["a"]))).toEqual({ read: 1, total: 2, unread: ["Ale"] })
    expect(readSummary([], new Set())).toEqual({ read: 0, total: 0, unread: [] })
  })
})

describe("What's New — the workspace menu", () => {
  it("every person with any access has it; a person with no access has nothing", () => {
    expect(modulesFor(["leads.worklist"]).map(m => m.key)).toContain("news")
    expect(modulesFor([]).map(m => m.key)).not.toContain("news")
  })
})

describe("Antonio's menu", () => {
  const workspaceHrefs = new Set(modulesFor(MARKETING_PERMISSIONS).filter(m => m.built).map(m => m.href))
  it("every link to a team screen is a screen the workspace really has (a renamed screen cannot leave a dead link)", () => {
    const links = OWNER_MENU.flatMap(i => [i, ...(i.children ?? [])]).map(i => i.href).filter(h => h.startsWith("/marketing/"))
    expect(links.length).toBeGreaterThan(5)
    expect(links.filter(h => !workspaceHrefs.has(h))).toEqual([])
  })
  it("has Documents, What's New, Board, Calendar and Messages in his own menu", () => {
    const keys = OWNER_MENU.map(i => i.key)
    for (const k of ["home", "news", "leads", "board", "calendar", "messages", "documents", "money", "team", "templates"]) expect(keys).toContain(k)
  })
  it("marks the open screen, opening a group's sub-links when one of them is open", () => {
    expect(activeOwnerItem("/marketing-leads")).toEqual({ item: "home", child: null })
    expect(activeOwnerItem("/marketing-leads/news")).toEqual({ item: "news", child: null })
    expect(activeOwnerItem("/marketing/documents")).toEqual({ item: "documents", child: null })
    expect(activeOwnerItem("/marketing/inbox")).toEqual({ item: "messages", child: "inbox" })
    expect(activeOwnerItem("/marketing/reports")).toEqual({ item: "team", child: "reports" })
    expect(activeOwnerItem("/marketing/board")).toEqual({ item: "board", child: null })
    expect(activeOwnerItem("/somewhere-else")).toEqual({ item: null, child: null })
  })
})
