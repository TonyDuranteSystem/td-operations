/**
 * Wiring guard for the left-menu ⋯ menu (dev job f3f3e237, step 1).
 *
 * The component has no DOM test (the unit suite runs in node), so these checks
 * pin the structural decisions the council reviews depended on — each one is a
 * way the feature silently breaks if someone "tidies" the code:
 *  - the button is a SIBLING of the nav <Link> (a button inside an anchor
 *    navigates away on click);
 *  - every menu item goes through the one SortableNavItem render site;
 *  - it is hidden in reorder mode (the drag grip owns that edge);
 *  - it is reachable on touch and by keyboard (no hover-only reveal).
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const sidebar = readFileSync(join(root, "components/dashboard/sidebar.tsx"), "utf8")
const menu = readFileSync(join(root, "components/dashboard/nav-item-menu.tsx"), "utf8")

function sortableItemBody(): string {
  const start = sidebar.indexOf("function SortableNavItem(")
  const end = sidebar.indexOf("function TeamNotifDot(")
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return sidebar.slice(start, end)
}

describe("left menu ⋯ wiring", () => {
  it("renders the menu inside SortableNavItem, after the nav Link closes (sibling, not child)", () => {
    const body = sortableItemBody()
    const linkClose = body.indexOf("</Link>")
    const menuUse = body.indexOf("<NavItemMenu")
    expect(linkClose).toBeGreaterThan(-1)
    expect(menuUse).toBeGreaterThan(linkClose)
  })

  it("does not render it in reorder (edit) mode", () => {
    expect(sortableItemBody()).toMatch(/\{!editMode && <NavItemMenu/)
  })

  it("passes the item's own address and name, and closes the mobile drawer", () => {
    expect(sortableItemBody()).toMatch(/<NavItemMenu href=\{item\.href\} name=\{item\.name\} onNavigate=\{onMobileClose\} overlay=\{overlay\}/)
  })

  it("floats over the row on mouse screens so names never lose width to a reserved slot (QA 2026-10-05)", () => {
    const body = sortableItemBody()
    // a row with the clickable Team Chat dot keeps a slot; every other row overlays
    expect(body).toMatch(/const overlay = !item\.dotBadge/)
    // both count badges step aside while the button is shown — via visibility, because the
    // red badge pulses and an animation would override an opacity change
    const aside = body.match(/badgeStepAside/g) ?? []
    expect(aside.length).toBeGreaterThanOrEqual(3) // definition + red badge + purple badge
    expect(body).toMatch(/group-hover:invisible/)
    expect(body).toMatch(/group-has-\[\[data-state=open\]\]:invisible/)
  })

  it("has exactly one place that renders nav items, so every page gets the menu", () => {
    const uses = sidebar.match(/<SortableNavItem\b/g) ?? []
    expect(uses.length).toBe(1)
  })

  it("lets long names shorten instead of wrapping next to the new button", () => {
    const body = sortableItemBody()
    expect(body).toMatch(/flex-1 min-w-0 truncate/)
    expect(body).toMatch(/flex-1 min-w-0 flex items-center/)
  })

  it("marks the row as a hover/focus group so the button can reveal itself", () => {
    expect(sortableItemBody()).toMatch(/'group relative flex items-center/)
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
    expect(menu).toContain("z-[70]")
  })
})
