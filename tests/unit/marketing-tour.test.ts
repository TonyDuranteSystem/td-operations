import { describe, it, expect } from "vitest"
import { DONE, PREVIEW_TOURS, TARGETS, WELCOME, boldParts, isTourKey, resolveTour, stepsFor, tourKeyFor, type TourKey } from "@/lib/marketing/tour"
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { defaultForSetting } from "@/lib/marketing/settings-schema"
import { modulesFor } from "@/lib/marketing/workspace"
import type { Bundles } from "@/lib/marketing/access"

const bundles = defaultForSetting("permission_bundles") as Bundles
const ALL = [...MARKETING_PERMISSIONS]
const keyFor = (perms: readonly string[]) => tourKeyFor({ memberRole: "member", permissions: perms, bundles })

describe("which tour a person gets", () => {
  it("the owner gets the owner tour", () => {
    expect(tourKeyFor({ memberRole: "owner", permissions: ALL, bundles })).toBe("owner")
  })
  it("a person whose access is exactly a role's gets that role's tour", () => {
    expect(keyFor(bundles.setter)).toBe("setter")
    expect(keyFor(bundles.seller)).toBe("seller")
    expect(keyFor(bundles.analyst)).toBe("analyst")
    expect(keyFor(bundles.content)).toBe("content")
  })
  it("a role with a change or two still gets its tour", () => {
    expect(keyFor([...bundles.setter, "reports.read"])).toBe("setter")
  })
  it("custom access that matches no role gets the generic tour", () => {
    expect(keyFor(["money.read", "calls.host", "offers.create", "content.manage"])).toBe("generic")
  })
})

describe("the tour content", () => {
  const keys: TourKey[] = ["owner", "setter", "seller", "analyst", "content"]
  it("every step is in both languages, has a known target, and bold marks are paired", () => {
    for (const k of keys) {
      for (const s of stepsFor(k, ALL)) {
        for (const lang of ["en", "it"] as const) {
          expect(s[lang].title.length).toBeGreaterThan(3)
          expect(s[lang].body.length).toBeGreaterThan(10)
          expect((s[lang].body.match(/\*\*/g) ?? []).length % 2).toBe(0)
        }
        expect(Object.keys(TARGETS)).toContain(s.target)
        expect(TARGETS[s.target].length).toBeGreaterThan(0)
        // a page heading is always the last choice, so a screen with no data still gets a spotlight
        expect(TARGETS[s.target][TARGETS[s.target].length - 1]).toBe("h1")
      }
    }
  })
  it("the Italian text is not the English text, and the welcome and the end are in both languages", () => {
    for (const k of keys) for (const s of stepsFor(k, ALL)) expect(s.it.title).not.toBe(s.en.title)
    expect(WELCOME.en.title).not.toBe(WELCOME.it.title)
    expect(DONE.en.close).not.toBe(DONE.it.close)
  })
  it("never tells a person about Antonio seeing everything", () => {
    const all = JSON.stringify([WELCOME, DONE, ...keys.map(k => stepsFor(k, ALL))])
    expect(all).not.toMatch(/Antonio can see everything|Antonio vede tutto/)
  })
})

describe("the steps a person is shown", () => {
  it("the default roles get exactly the steps of the approved mockup", () => {
    expect(stepsFor("owner", ALL).map(s => s.screen)).toEqual(["board", "leads", "calendar", "chat", "templates", "team", "money"])
    expect(stepsFor("setter", bundles.setter).map(s => s.screen)).toEqual(["call-list", "call-list", "calendar", "chat", "templates", "my-numbers"])
    expect(stepsFor("seller", bundles.seller).map(s => s.screen)).toEqual(["today", "calendar", "chat", "templates", "reports"])
    expect(stepsFor("analyst", bundles.analyst).map(s => s.screen)).toEqual(["board", "activity", "calendar", "reports"])
    expect(stepsFor("content", bundles.content).map(s => s.screen)).toEqual(["board", "reports", "chat"])
  })
  it("a step is dropped when the person does not have its screen (access was changed)", () => {
    const noChat = bundles.setter.filter(p => p !== "chat")
    expect(stepsFor("setter", noChat).map(s => s.screen)).not.toContain("chat")
    const noTemplates = bundles.setter.filter(p => p !== "leads.mark")
    expect(stepsFor("setter", noTemplates).map(s => s.screen)).not.toContain("templates")
  })
  it("every step's screen is a screen that exists in the workspace menu", () => {
    const real = new Set(modulesFor(ALL).filter(m => m.built).map(m => m.key))
    for (const k of ["owner", "setter", "seller", "analyst", "content"] as const) for (const s of stepsFor(k, ALL)) expect(real.has(s.screen)).toBe(true)
  })
  it("the generic tour has one step per screen the person has, never a screen he lacks", () => {
    const perms = ["leads.read", "chat", "reports.read"]
    const have = new Set(modulesFor(perms).filter(m => m.built).map(m => m.key))
    const screens = stepsFor("generic", perms).map(s => s.screen)
    expect(new Set(screens).size).toBe(screens.length)
    for (const s of screens) expect(have.has(s)).toBe(true)
    expect(screens.length).toBeGreaterThan(0)
  })
  it("the owner can preview each role's tour in full (he holds every screen)", () => {
    for (const k of PREVIEW_TOURS) expect(stepsFor(k, ALL).length).toBeGreaterThan(0)
    expect(stepsFor("setter", ALL).length).toBe(6)
  })
})

describe("wording matches the real screens", () => {
  it("the owner's Team step mentions the role previews; a custom-access manager's generic tour does not (he has no such box)", () => {
    const owner = resolveTour("owner", ALL, "en").find(s => s.screen === "team")!
    expect(owner.body).toContain("See each role's tour")
    expect(resolveTour("owner", ALL, "it").find(s => s.screen === "team")!.body).toContain("Vedi il giro di ogni ruolo")
    const generic = resolveTour("generic", ["team.manage", "leads.read", "chat"], "en").find(s => s.screen === "team")
    expect(generic?.body ?? "").not.toContain("See each role's tour")
  })
  it("names the buttons the screens really have", () => {
    const setter = resolveTour("setter", bundles.setter, "en").map(s => s.body).join(" ")
    expect(setter).toContain("Pass to Rocco")
    expect(setter).not.toContain("**Hand over**")
    const seller = resolveTour("seller", bundles.seller, "en")[0].body
    expect(seller).toContain("Pick this lead")
    expect(resolveTour("seller", bundles.seller, "it")[0].body).toContain("Prendi questo lead")
  })
})

describe("resolveTour", () => {
  it("gives the person's language and the address of each screen", () => {
    const it = resolveTour("setter", bundles.setter, "it")
    expect(it[0]).toMatchObject({ href: "/marketing/call-list", title: "Lista chiamate: il tuo lavoro di oggi" })
    expect(resolveTour("setter", bundles.setter, "en")[0].title).toBe("Call list: your work for today")
  })
})

describe("boldParts and isTourKey", () => {
  it("splits **bold** into pieces and never produces raw html", () => {
    expect(boldParts("Press **Pick** now")).toEqual([{ text: "Press ", bold: false }, { text: "Pick", bold: true }, { text: " now", bold: false }])
    expect(boldParts("no marks")).toEqual([{ text: "no marks", bold: false }])
    expect(boldParts("")).toEqual([])
  })
  it("knows the tour keys", () => {
    expect(isTourKey("owner")).toBe(true)
    expect(isTourKey("generic")).toBe(true)
    expect(isTourKey("hacker")).toBe(false)
    expect(isTourKey(5)).toBe(false)
  })
})
