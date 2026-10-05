/**
 * Wiring guard for the window manager component (dev job f3f3e237, step 5). The unit suite has no
 * DOM, so these pin the decisions the council hinged on — each is a way the windows could break
 * the CRM or leak if someone "tidies" the component.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const manager = read("components/windows/window-manager.tsx")
const menu = read("components/dashboard/nav-item-menu.tsx")
const sidebar = read("components/dashboard/sidebar.tsx")

describe("window manager", () => {
  it("only trusts messages from its own windows: same site AND a frame it created", () => {
    expect(manager).toMatch(/e\.origin !== window\.location\.origin/)
    expect(manager).toMatch(/f\.contentWindow === source/)
  })

  it("every address goes through the window rules, including after a window navigates", () => {
    expect(manager).toContain("openWindow(stateRef.current, d?.href, d?.title, v)")
    expect(manager).toMatch(/!isWindowableUrl\(msg\.url\)/)
  })

  it("desktop only: renders nothing below the desktop width", () => {
    expect(manager).toMatch(/vp\.vw < WINDOWS_MIN_VIEWPORT_WIDTH\) return null/)
    expect(manager).toContain("hidden lg:block")
  })

  it("sits between the notes/chat layer and in-page overlays, as its own stacking context, and is never a dialog", () => {
    expect(manager).toContain("z-[44]")
    expect(manager).toContain("isolation: 'isolate'")
    expect(manager).not.toMatch(/role="dialog"/)
  })

  it("is left out of screen captures (frames would render blank)", () => {
    expect(manager).toContain("CAPTURE_TOOL_IGNORE_ATTR")
  })

  it("a minimised window keeps its page alive (hidden, not removed) so typing is not lost", () => {
    expect(manager).toMatch(/w\.minimized && 'hidden'/)
  })

  it("a signed-out or dead window removes its page instead of showing a login form inside a frame", () => {
    expect(manager).toMatch(/const mountFrame = st === 'ok'/)
    expect(manager).toMatch(/isSignedOutPath\(path\)/)
  })

  it("closing, popping out or docking all ask about unsent typing first", () => {
    expect(manager).toMatch(/guarded\(w\.id, 'popout'\)/)
    expect(manager).toMatch(/guarded\(w\.id, 'dock'\)/)
    expect(manager).toMatch(/guarded\(w\.id, 'close'\)/)
  })

  it("covers the frames while dragging or resizing (frames swallow the mouse)", () => {
    expect(manager).toMatch(/dragCursor && <div/)
  })

  it("forgets everything when the session ends, however it ends", () => {
    expect(manager).toContain("onAuthStateChange")
    expect(manager).toMatch(/event === 'SIGNED_OUT'/)
    expect(manager).toContain("pruneOtherUsers(store, userId)")
    expect(sidebar).toContain("clearAllWindows(browserStore())")
  })

  it("Cmd+K from inside a window opens the main page's search", () => {
    expect(manager).toContain("new CustomEvent('open-command-palette')")
  })
})

describe("left-menu entry", () => {
  it("shows 'Open in floating window' only when windows are available, for a real CRM page, on desktop", () => {
    expect(menu).toContain("windowsAvailable && isWindowableUrl(href)")
    expect(menu).toContain("'hidden lg:flex'")
    expect(menu).toContain("requestOpenWindow(href, name)")
  })
})
