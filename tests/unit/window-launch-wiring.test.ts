/**
 * Floating windows, step 6: the launcher, Option-click and the search palette's "as a window"
 * (dev job f3f3e237). The unit suite has no DOM, so the clicks/keys are pure helpers and the wiring
 * is pinned by source checks.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { isWindowOpenClick, isWindowOpenKey } from "@/lib/windows/open-intent"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

describe("isWindowOpenClick", () => {
  it("is Option/Alt + plain left click, and nothing else", () => {
    expect(isWindowOpenClick({ button: 0, altKey: true })).toBe(true)
    expect(isWindowOpenClick({ altKey: true })).toBe(true) // button defaults to the left one
  })
  it("never takes over the browser's own clicks", () => {
    expect(isWindowOpenClick({ button: 0 })).toBe(false) // plain click: normal navigation
    expect(isWindowOpenClick({ button: 0, metaKey: true })).toBe(false) // Cmd-click: new tab
    expect(isWindowOpenClick({ button: 0, ctrlKey: true })).toBe(false)
    expect(isWindowOpenClick({ button: 0, shiftKey: true })).toBe(false) // Shift-click: new window
    expect(isWindowOpenClick({ button: 0, altKey: true, metaKey: true })).toBe(false)
    expect(isWindowOpenClick({ button: 0, altKey: true, shiftKey: true })).toBe(false)
    expect(isWindowOpenClick({ button: 1, altKey: true })).toBe(false) // middle button
    expect(isWindowOpenClick({ button: 2, altKey: true })).toBe(false) // right button stays native
  })
})

describe("isWindowOpenKey", () => {
  it("is Cmd+Enter or Ctrl+Enter", () => {
    expect(isWindowOpenKey({ key: "Enter", metaKey: true })).toBe(true)
    expect(isWindowOpenKey({ key: "Enter", ctrlKey: true })).toBe(true)
  })
  it("plain Enter and other keys keep their normal meaning", () => {
    expect(isWindowOpenKey({ key: "Enter" })).toBe(false)
    expect(isWindowOpenKey({ key: "k", metaKey: true })).toBe(false)
    expect(isWindowOpenKey({ key: "Enter", metaKey: true, shiftKey: true })).toBe(false)
    expect(isWindowOpenKey({ key: "Enter", metaKey: true, altKey: true })).toBe(false)
  })
})

describe("sidebar wiring", () => {
  const sidebar = read("components/dashboard/sidebar.tsx")

  it("the launcher is handed the SAME permission-filtered list the menu renders", () => {
    expect(sidebar).toContain("<WindowsLauncher items={orderedNav} />")
    // orderedNav is the list after the admin-only / owner-only / feature-flag filter
    const filter = sidebar.indexOf("if (item.adminOnly && !isAdmin) return false")
    expect(filter).toBeGreaterThan(sidebar.indexOf("const orderedNav"))
    expect(filter).toBeLessThan(sidebar.indexOf("<WindowsLauncher"))
  })

  it("Option-click opens a window only when windows are on, and otherwise leaves the click alone", () => {
    expect(sidebar).toMatch(/windowsAvailable && isWindowOpenClick\(e\) && isWindowableUrl\(item\.href\)/)
  })
})

describe("launcher", () => {
  const launcher = read("components/dashboard/windows-launcher.tsx")

  it("renders nothing unless windows are on, is desktop only, and only lists pages a window may show", () => {
    expect(launcher).toMatch(/if \(!available\) return null/)
    expect(launcher).toContain("hidden w-full items-center")
    expect(launcher).toContain("lg:flex")
    expect(launcher).toContain("items.filter(i => isWindowableUrl(i.href))")
  })

  it("opens through the one shared opener", () => {
    expect(launcher).toContain("requestOpenWindow(p.href, p.name)")
  })
})

describe("search palette", () => {
  const palette = read("components/dashboard/command-palette.tsx")

  it("Cmd/Ctrl+Enter and modified click open a window only when windows are on and the page may be a window", () => {
    expect(palette).toContain("navigate(results[selectedIndex], isWindowOpenKey(e))")
    expect(palette).toContain("navigate(result, e.metaKey || e.ctrlKey || e.altKey)")
    expect(palette).toMatch(/asWindow && windowsAvailable && isWindowableUrl\(result\.href\)/)
  })

  it("plain Enter and plain click still just open the page", () => {
    expect(palette).toContain("router.push(result.href)")
  })
})
