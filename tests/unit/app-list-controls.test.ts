/**
 * TD Social phone app — the slim top of the Inbox and WhatsApp lists (dev job 2072bc3e, 6 Nov 2026; the approved mockup "A slimmer top for the Inbox").
 * The bar is pure arrangement of the shell's own values and handlers, so these tests pin: what it shows at rest and with the search box open (safe to
 * render on the server), and — by reading the shell source, as the other app-mode guards do — that it replaces the old rows ONLY when the slim top is
 * on (the phone app with the title bar), that the old rows keep every control they had for the computer and for older app builds, and that every
 * search piece the old row drew is still drawn (one definition, two places).
 */
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "fs"
import { join } from "path"
import { AppListControls, LIST_FILTERS } from "@/components/inbox/app-list-controls"

const noop = () => undefined
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const base = { filter: "all" as const, onFilter: noop, value: "", onChange: noop, onClear: noop, placeholder: "Search emails..." }

describe("AppListControls at rest", () => {
  const out = html(createElement(AppListControls, { ...base, folders: createElement("button", null, "Folders") }))

  it("shows Folders, the three filters and a Search button, and no typing box", () => {
    expect(out).toContain("Folders")
    for (const f of LIST_FILTERS) expect(out).toContain(`>${f.label}<`)
    expect(out).toContain('aria-label="Search"')
    expect(out).not.toContain("<input")
    expect(out).not.toContain("Cancel")
  })

  it("has the three filters the old rows had, in the same order", () => {
    expect(LIST_FILTERS.map(f => f.key)).toEqual(["all", "unread", "read"])
    expect(LIST_FILTERS.map(f => f.label)).toEqual(["All", "Unread", "Read"])
  })

  it("marks the chosen filter and keeps its colours (blue for Unread, grey for Read)", () => {
    const unread = html(createElement(AppListControls, { ...base, filter: "unread" }))
    expect(unread).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-blue-100 text-blue-700[^"]*"[^>]*>Unread</)
    const read = html(createElement(AppListControls, { ...base, filter: "read" }))
    expect(read).toMatch(/aria-pressed="true"[^>]*class="[^"]*bg-zinc-200 text-zinc-700[^"]*"[^>]*>Read</)
  })

  it("an Inbox bar has Folders, a WhatsApp bar (no Folders passed) has none", () => {
    expect(html(createElement(AppListControls, base))).not.toContain("Folders")
  })

  it("steps aside while an email or chat is open: nothing inside it (so no typing box can keep the keyboard up over the chat)", () => {
    const aside = html(createElement(AppListControls, { ...base, hidden: true, defaultOpen: true, value: "balance" }))
    expect(aside).toMatch(/class="hidden"/)
    expect(aside).not.toContain("<input")
    expect(aside).not.toContain("Cancel")
    expect(html(createElement(AppListControls, base))).not.toMatch(/class="hidden"/)
  })
})

describe("AppListControls with the search box open", () => {
  const open = (extra: Record<string, unknown> = {}) =>
    html(createElement(AppListControls, { ...base, defaultOpen: true, folders: createElement("button", null, "Folders"), ...extra }))

  it("shows the typing box, Cancel and the filters on a slim line; Folders steps aside", () => {
    const out = open()
    expect(out).toContain("<input")
    expect(out).toContain('placeholder="Search emails..."')
    expect(out).toContain("Cancel")
    for (const f of LIST_FILTERS) expect(out).toContain(`>${f.label}<`)
    expect(out).toContain("app-slim-buttons")
    expect(out).not.toContain("Folders")
  })

  it("the box asks the iPhone for the search key and never capitalises 'from:'", () => {
    const out = open()
    expect(out).toContain('enterKeyHint="search"')
    expect(out).toContain('autoCapitalize="none"')
    expect(out).toContain('autoCorrect="off"')
  })

  it("text in the box stays open even without a tap (a search that is running), with a Clear button", () => {
    const out = html(createElement(AppListControls, { ...base, value: "balance" }))
    expect(out).toContain("<input")
    expect(out).toContain('value="balance"')
    expect(out).toContain('aria-label="Clear search"')
  })

  it("an empty box has no Clear button", () => {
    expect(open()).not.toContain("Clear search")
  })

  it("draws the Include-archived switch and the suggestion list the shell passes, and nothing when none is passed", () => {
    const withExtras = open({ scope: createElement("span", null, "SCOPE-CHIP"), dropdown: createElement("div", null, "DROPDOWN") })
    expect(withExtras).toContain("SCOPE-CHIP")
    expect(withExtras).toContain("DROPDOWN")
    const plain = open()
    expect(plain).not.toContain("SCOPE-CHIP")
    expect(plain).not.toContain("DROPDOWN")
  })
})

const root = join(__dirname, "..", "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const shell = src("components/inbox/inbox-shell.tsx")

describe("the Inbox shell: the slim top only in the phone app, the old rows untouched for everyone else", () => {
  it("the slim top is decided by the same hook the title bar uses (older app builds keep the old rows)", () => {
    expect(shell).toContain("const compactTop = useYouBridge()")
    expect(src("components/app-mode/app-you-button.tsx")).toMatch(/export function useYouBridge\(\): boolean/)
  })

  it("the old mailbox row, Gmail search row and WhatsApp search row render only when the slim top is OFF", () => {
    expect(shell).toContain("{!isWhatsApp && canUsePersonalMailbox && !compactTop && (")
    expect(shell).toContain("{!isWhatsApp && !compactTop && (")
    expect(shell).toContain("{isWhatsApp && !compactTop && (")
  })

  it("the slim bar is drawn for the Inbox (with Folders) and for WhatsApp (without) only when the slim top is ON", () => {
    expect(shell).toContain("{!isWhatsApp && compactTop && (")
    expect(shell).toContain("{isWhatsApp && compactTop && (")
    expect((shell.match(/<AppListControls/g) ?? []).length).toBe(2)
    expect(shell).toContain("onClick={() => setFolderSheetOpen(true)}")
  })

  it("the mailbox switch moves into the title bar (admin-only, Inbox only) and the title keeps its test marker", () => {
    expect(shell).toContain("{appMode && !selected && <AppListTitle title={isWhatsApp ? 'WhatsApp' : 'Inbox'}>")
    expect(shell).toContain("{!isWhatsApp && canUsePersonalMailbox && (")
    expect(shell).toContain('aria-label="Mailbox"')
  })

  it("the computer row and the slim bar share ONE definition of the Enter/Escape handler, the suggestion list and the scope switch", () => {
    expect(shell).toContain("const searchKeyDown = ")
    expect(shell).toContain("const searchDropdown = suggestOpen ? (")
    expect(shell).toContain("const scopeChip = searchActive ? (")
    expect(shell).toContain("onKeyDown={searchKeyDown}")
    expect(shell).toContain("{searchDropdown}")
    expect(shell).toContain("{scopeChip}")
    expect(shell).toContain("scope={scopeChip}")
    expect(shell).toContain("dropdown={searchDropdown}")
    // the suggestion list is built once, not copied per row
    expect((shell.match(/<SearchSuggestDropdown/g) ?? []).length).toBe(1)
  })

  it("the old computer row still has its Gmail-style placeholder, the leftover divider and its three filters", () => {
    expect(shell).toContain('placeholder="Search emails... (from:, subject:, has:attachment)"')
    expect(shell).toContain('<div className="flex items-center gap-0.5 border-l pl-2 ml-1">')
    expect(shell).toContain("{f === 'all' ? 'All' : f === 'unread' ? 'Unread' : 'Read'}")
  })

  it("the slim line's 36 px buttons are an app-only rule", () => {
    const css = src("app/globals.css")
    expect(css).toContain('[data-app-mode="true"] .app-slim-buttons button { min-height: 36px !important; }')
  })
})
