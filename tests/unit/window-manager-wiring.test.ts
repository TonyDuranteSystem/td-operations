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
    expect(manager).toContain("openWindow(base, d?.href, d?.title, v)")
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

  it("a narrow screen neither shrinks nor re-saves the remembered windows, and a request before the first measurement is not dropped", () => {
    expect(manager).toContain("Math.max(v.vw, WINDOWS_MIN_VIEWPORT_WIDTH)")
    expect(manager).toMatch(/if \(v\.vw >= WINDOWS_MIN_VIEWPORT_WIDTH\) commit\(clampAll/)
    expect(manager).toMatch(/vpRef\.current\.vw < WINDOWS_MIN_VIEWPORT_WIDTH\) return/)
    expect(manager).toContain("vpRef.current ?? readViewport(topInset)")
  })

  it("a page's own back arrow takes its window one step back along the window's own trail", () => {
    expect(manager).toContain("goBackRef.current(id)")
    expect(manager).toContain("goBackForward(id, -1)")
  })

  it("is never built inside a frame or a pop-out window, and once on it stays on", () => {
    expect(manager).toContain("setAllowed(!isFramedOrPopout())")
    const ctx = read("lib/windows/windows-context.ts")
    expect(ctx).toContain("window.self !== window.top")
    expect(ctx).toContain("window.name.startsWith(POPOUT_NAME)")
    expect(manager).toContain("const [on] = useState(enabled)")
  })

  it("a crash inside the windows cannot white-screen the CRM", () => {
    expect(manager).toContain("class WindowsCrashGuard")
    expect(manager).toContain("<WindowsCrashGuard>")
  })

  it("draws windows in a stable order and stacks with z-index only (re-ordering reloads a window's page)", () => {
    expect(manager).toContain("state.windows.map(w => {")
    expect(manager).not.toMatch(/\[\.\.\.state\.windows\]\.sort\([^)]*\)\.map\(\(w, rank\)/)
    // drag listens on the window (not element pointer capture, which was lost in real use and left the sheet stuck)
    expect(manager).toContain("window.addEventListener('pointerup', end)")
    expect(manager).toContain("window.addEventListener('blur', end)")
    expect(manager).not.toContain("setPointerCapture")
  })

  it("closing a minimised window with unsent typing shows the question (the window is shown first)", () => {
    expect(manager).toMatch(/commit\(focusWindow\(restoreWindow\(stateRef\.current, id\), id\)\)\s*setConfirm/)
  })

  it("reload is guarded like close, and a back/forward the frame never answers is undone", () => {
    expect(manager).toContain("guarded(w.id, 'reload')")
    expect(manager).toContain("t.idx = t.prevIdx")
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
