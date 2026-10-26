import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { moveNav, orderNav, parseSavedOrder } from "@/lib/marketing/nav-order"
import { SEARCH_LIMIT, cleanSearch, searchDigits, searchFilter } from "@/lib/marketing/lead-search"
import { parseTheme, DEFAULT_THEME } from "@/lib/marketing/theme"
import { columnsFor } from "@/lib/marketing/board"
import { IT } from "@/lib/marketing/i18n-it"
import { isLeadId, openWindow, closeWindow, EMPTY_WINDOWS } from "@/lib/marketing/lead-windows"
import { isFrameHidden, setFrameHidden } from "@/lib/marketing/frame-visibility"
import { modulesFor } from "@/lib/marketing/workspace"

describe("the sidebar order a person chose", () => {
  const items = ["board", "cal", "chat", "leads"].map(key => ({ key }))
  it("follows the saved order; an unknown saved key is ignored; a screen that is new goes last, so it never disappears", () => {
    expect(orderNav(items, ["leads", "ghost", "board"]).map(i => i.key)).toEqual(["leads", "board", "cal", "chat"])
    expect(orderNav(items, null).map(i => i.key)).toEqual(["board", "cal", "chat", "leads"])
    expect(orderNav(items, []).map(i => i.key)).toEqual(["board", "cal", "chat", "leads"])
  })
  it("moves one place up or down and stops at the ends", () => {
    expect(moveNav(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"])
    expect(moveNav(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"])
    expect(moveNav(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"])
    expect(moveNav(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"])
    expect(moveNav(["a", "b", "c"], 9, 1)).toEqual(["a", "b", "c"])
  })
  it("only plain keys are read back from the browser", () => {
    expect(parseSavedOrder("board, cal,<script>,chat")).toEqual(["board", "cal", "chat"])
    expect(parseSavedOrder(null)).toEqual([])
  })
})

describe("the search bar", () => {
  it("needs two characters, keeps names, emails and phone signs, and drops anything that could change the database filter", () => {
    expect(cleanSearch("a")).toBeNull()
    expect(cleanSearch("  Mario  Rossi ")).toBe("Mario Rossi")
    expect(cleanSearch("mario@x.com")).toBe("mario@x.com")
    expect(cleanSearch("+39 335 12")).toBe("+39 335 12")
    expect(cleanSearch("a,b),full_name.eq.x")).not.toMatch(/[,()%*'"]/)
    expect(cleanSearch("%%__")).toBeNull()
    expect(cleanSearch(42)).toBeNull()
    expect((cleanSearch("x".repeat(500)) ?? "").length).toBeLessThanOrEqual(60)
  })
  it("a phone filter is added only for numbers of 4+ digits and only for people who may see phone numbers", () => {
    expect(searchDigits("+39 335 12")).toBe("3933512")
    expect(searchDigits("ab 12")).toBeNull()
    // an email or a name with digits in it is not a phone number: no loose phone match that would push the real lead out
    expect(searchFilter("mario1985@gmail.com", true)).not.toContain("phone")
    expect(searchFilter("Studio 2025", true)).not.toContain("phone")
    expect(searchFilter("Mario", true)).toBe("full_name.ilike.%Mario%,email.ilike.%Mario%")
    expect(searchFilter("335 123", true)).toContain("phone.ilike.%3%3%5%1%2%3%")
    expect(searchFilter("335 123", false)).not.toContain("phone")
    expect(SEARCH_LIMIT).toBe(8)
  })
})

describe("the look", () => {
  it("only light, dark or system; anything else (a tampered cookie) is the default", () => {
    expect(parseTheme("dark")).toBe("dark")
    expect(parseTheme("light")).toBe("light")
    expect(parseTheme("blue")).toBe(DEFAULT_THEME)
    expect(parseTheme(undefined)).toBe("system")
  })
})

describe("the dark look covers every colour class the screens use", () => {
  const root = process.cwd()
  const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p) } return out }
  const files = [...walk(join(root, "app/marketing")), ...walk(join(root, "components/marketing")), join(root, "components/talk/talk-messages.tsx"), join(root, "components/talk/talk-composer.tsx"), join(root, "components/talk/talk-sheet.tsx"), join(root, "components/team-chat/voice-note.tsx")]
  const css = readFileSync(join(root, "app/marketing/marketing-dark.css"), "utf8")
  const NEEDS = [/^bg-white$/, /^bg-(slate|zinc)-(50|100|200|300)$/, /^bg-(amber|sky|rose|red|emerald|teal)-(50|100)$/, /^text-(slate|zinc)-\d+$/, /^text-(amber|sky|rose|red|emerald|teal|blue)-\d+$/, /^border-(zinc|slate)-\d+$/, /^border-(amber|sky|rose|red|emerald)-\d+$/]
  // a saturated fill with white text reads the same in both looks: text-red-600 etc. are TEXT colours and are covered above
  const classes = new Set<string>()
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/(?<![\w:-])((?:bg|text|border)-[a-z]+(?:-\d{2,3})?)(?![\w/-])/g)) classes.add(m[1])
  const escapeCls = (c: string) => c.replace(/[:/[\].#]/g, x => "\\" + x)
  it("every light colour class in use has a dark rule", () => {
    const missing = Array.from(classes).filter(c => NEEDS.some(r => r.test(c))).filter(c => !css.includes(`.${escapeCls(c)}{`))
    expect(missing).toEqual([])
  })
  it("the dark rules exist for both a chosen Dark and System + a dark computer", () => {
    expect(css).toContain('[data-tdm-theme="dark"] .bg-white')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('[data-tdm-theme="system"] .bg-white')
  })
})

describe("the seller's board words", () => {
  it("are Rocco's six, in his words, all translated", () => {
    const labels = columnsFor("seller").map(c => c.label)
    expect(labels).toEqual(["Booked calls", "Not in target", "Closed", "Not closed", "Not ready now", "Paid"])
    expect(labels.map(l => IT[l])).toEqual(["Chiamate fissate", "Fuori target", "Chiuso", "Non chiuso", "Non pronto ora", "Pagato"])
    for (const l of labels) expect(IT[l], l).toBeTruthy()
  })
})

describe("review fixes (bug hunt on PR 823)", () => {
  const ID = "0b0e6a1c-3d5f-4c3a-9a47-5a1d2f7e8b90"
  it("only a real uuid is a lead id (a string of 36 hyphens is not)", () => {
    expect(isLeadId(ID)).toBe(true)
    expect(isLeadId("-".repeat(36))).toBe(false)
    expect(isLeadId("0b0e6a1c-3d5f-4c3a-9a47-5a1d2f7e8b9")).toBe(false)
  })
  it("a window opened with no name keeps a real name already known, and a closed one can be opened again", () => {
    const vp = { w: 1400, h: 900 }
    let s = openWindow(EMPTY_WINDOWS, { id: ID, name: "Mario Rossi" }, vp)
    s = openWindow(s, { id: ID, name: "", tab: "chat" }, vp)
    expect(s.list[0].name).toBe("Mario Rossi")
    expect(s.list[0].tab).toBe("chat")
    s = closeWindow(s, ID)
    s = openWindow(s, { id: ID, name: "" }, vp)
    expect(s.list).toHaveLength(1)
  })
  it("a window page starts visible and follows what the board tells it", () => {
    expect(isFrameHidden()).toBe(false)
    setFrameHidden(true)
    expect(isFrameHidden()).toBe(true)
    setFrameHidden(false)
  })
  it("the Chat entry needs only the chat permission (direct messages and groups are for the whole team; the chats about leads need more and the page checks that)", () => {
    expect(modulesFor(["chat"]).some(m => m.key === "chat")).toBe(true)
    expect(modulesFor(["leads.read"]).some(m => m.key === "chat")).toBe(false)
  })
})
