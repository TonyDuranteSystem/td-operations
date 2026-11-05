/**
 * Wiring guard for the left-menu ⋯ menu (dev job f3f3e237, step 1; moved to the shared row by dev job 45aa5872).
 *
 * The component has no DOM test (the unit suite runs in node), so these checks
 * pin the structural decisions the council reviews depended on — each one is a
 * way the feature silently breaks if someone "tidies" the code:
 *  - the button is a SIBLING of the nav <Link> (a button inside an anchor
 *    navigates away on click);
 *  - every page goes through the ONE NavItemRow (main list, group panel, phone drawer), so every page gets the menu;
 *  - it is not drawn while the menu is being edited (the drag grip owns that edge);
 *  - it is reachable on touch and by keyboard (no hover-only reveal).
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const sidebar = read("components/dashboard/sidebar.tsx")
const groups = read("components/dashboard/menu-groups.tsx")
const editor = read("components/dashboard/menu-editor.tsx")
const rowFile = read("components/dashboard/nav-item-row.tsx")
const menu = read("components/dashboard/nav-item-menu.tsx")

function rowBody(): string {
  const start = rowFile.indexOf("export function NavItemRow(")
  const end = rowFile.indexOf("export function TeamNotifDot(")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return rowFile.slice(start, end)
}

describe("left menu ⋯ wiring", () => {
  it("renders the menu inside NavItemRow, after the nav Link closes (sibling, not child)", () => {
    const body = rowBody()
    const linkClose = body.indexOf("</Link>")
    const menuUse = body.indexOf("<NavItemMenu")
    expect(linkClose).toBeGreaterThan(-1)
    expect(menuUse).toBeGreaterThan(linkClose)
  })

  it("is not drawn while editing the menu (the editor has its own rows with a drag grip and no ⋯)", () => {
    expect(editor).not.toContain("NavItemMenu")
    expect(sidebar).toMatch(/editMode \? \(/)
    expect(sidebar).toContain("<EditMenuTree")
  })

  it("passes the item's own address and name, and closes the mobile drawer", () => {
    expect(rowBody()).toMatch(/<NavItemMenu href=\{item\.href\} name=\{item\.name\} onNavigate=\{onMobileClose\} overlay=\{overlay\}/)
  })

  it("floats over the row on mouse screens so names never lose width to a reserved slot (QA 2026-10-05)", () => {
    const body = rowBody()
    // a row with the clickable Team Chat dot keeps a slot; every other row overlays
    expect(body).toMatch(/const overlay = !item\.dotBadge/)
    // both count badges step aside while the button is shown — via visibility, because the
    // red badge pulses and an animation would override an opacity change
    const aside = body.match(/badgeStepAside/g) ?? []
    expect(aside.length).toBeGreaterThanOrEqual(3) // definition + red badge + purple badge
    expect(body).toMatch(/group-hover:invisible/)
    expect(body).toMatch(/group-has-\[\[data-state=open\]\]:invisible/)
  })

  it("has exactly one component that draws a page row, so every page gets the menu wherever it sits", () => {
    // the only place a page's own link is written
    expect((rowFile.match(/<Link\s+href=\{item\.href\}/g) ?? []).length).toBe(1)
    expect(sidebar).not.toMatch(/<Link\b/)
    expect(groups).not.toMatch(/<Link\b/)
    // main list (sidebar) and group panel / phone drawer (menu-groups) both draw it
    expect((sidebar.match(/<NavItemRow\b/g) ?? []).length).toBe(1)
    expect((groups.match(/<NavItemRow\b/g) ?? []).length).toBe(1)
  })

  it("lets long names shorten instead of wrapping next to the new button", () => {
    const body = rowBody()
    expect(body).toMatch(/flex-1 min-w-0 truncate/)
    expect(body).toMatch(/flex-1 min-w-0 flex items-center/)
  })

  it("marks the row as a hover/focus group so the button can reveal itself", () => {
    expect(rowBody()).toMatch(/"group relative flex items-center/)
  })
})

describe("NavItemMenu component", () => {
  it("is reachable by keyboard and on touch screens (no hover-only reveal)", () => {
    expect(menu).toContain("group-focus-within:opacity-100")
    expect(menu).toContain("focus-visible:opacity-100")
    expect(menu).toContain("[@media(hover:none)]:opacity-100")
  })

  it("opens the page with a real new-tab anchor, safely", () => {
    expect(menu).toMatch(/<a href=\{href\} target="_blank" rel="noopener noreferrer"/)
  })

  it("refuses to build a menu for anything but a normal CRM path", () => {
    expect(menu).toMatch(/if \(!isInternalNavHref\(href\)\) return null/)
  })

  it("never claims the link was copied unless the clipboard write succeeded", () => {
    expect(menu).toMatch(/writeText\(url\)\s*\.then\(\(\) => toast\.success\('Link copied\.'\)\)\s*\.catch\(\(\) => toast\.error/)
  })

  it("only overlays the row on screens with a mouse (touch screens keep a slot)", () => {
    expect(menu).toContain("[@media(hover:hover)]:absolute")
    expect(menu).toContain("[@media(hover:hover)]:right-1")
    expect(menu).toMatch(/overlay &&/)
    expect(menu).toMatch(/overlay = false/)
  })

  it("is portalled above the mobile drawer", () => {
    expect(menu).toContain("DropdownMenu.Portal")
    // above the group panel (z-[96]), which is above the Supabase incident bar (z-[95])
    expect(menu).toContain("z-[100]")
  })

  it("offers 'Move to…' (groups, the main list, and a new group) only when the caller can move pages, and keeps focus out of the name box's way", () => {
    expect(menu).toContain("move?: MoveMenu")
    expect(menu).toMatch(/\{move && \(/)
    expect(menu).toContain("Move to…")
    expect(menu).toContain("New group…")
    expect(menu).toContain("keepFocus")
  })
})
