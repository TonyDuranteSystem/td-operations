/**
 * Wiring guard for window mode (dev job f3f3e237, step 3 — the frame TEST).
 *
 * The shell has no DOM test (the unit suite runs in node), so these checks pin the
 * decisions the council reviews hinged on. Each is a way the whole CRM could break
 * for everyone if someone "tidies" the layout:
 *  - the decision is made ONCE and frozen (a refresh must not flip a window back);
 *  - the tree keeps the SAME shape in both modes (chrome renders nothing, it is not removed);
 *  - the login check and the main scrolling area are never made conditional;
 *  - with the test flag off, nothing changes anywhere.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const layout = readFileSync(join(root, "app/(dashboard)/layout.tsx"), "utf8")
const shell = readFileSync(join(root, "components/dashboard/embedded-shell.tsx"), "utf8")
const helper = readFileSync(join(root, "lib/embed/embedded-request.ts"), "utf8")

const CHROME = [
  "SandboxBanner",
  "SwRegister",
  "RealtimeNotifications",
  "ClearAllToasts",
  "DashboardPullToRefresh",
  "Sidebar",
  "DashboardHeader",
  "CommandPalette",
  "AiAgentPanel",
  "StickyNotesLayer",
  "CaptureLayer",
  "MyCapturesOverlay",
  "FloatingChat",
]

describe("layout: window mode", () => {
  it("wraps every piece of chrome in ChromeOnly, so a window shows none of it", () => {
    for (const name of CHROME) {
      const wrapped = new RegExp(`<ChromeOnly>\\s*<${name}\\b`).test(layout)
      expect(wrapped, `${name} must be inside <ChromeOnly>`).toBe(true)
    }
  })

  it("keeps the live-update listener and the main area available in a window", () => {
    expect(layout).toMatch(/(?<!<ChromeOnly>\s*)<UiEventListener \/>/)
    expect(layout).not.toMatch(/<ChromeOnly>\s*<UiEventListener/)
    expect(layout).toMatch(/<ShellMain>[\s\S]*\{children\}[\s\S]*<\/ShellMain>/)
  })

  it("always runs the login check, whatever the window mode", () => {
    const login = layout.indexOf("if (!user) {")
    const embeddedDecision = layout.indexOf("isFramedNavigation(headers()")
    expect(login).toBeGreaterThan(-1)
    expect(embeddedDecision).toBeGreaterThan(login)
    expect(layout).toMatch(/redirect\('\/login'\)/)
  })

  it("reads the admin switch on every load, and a page is only a window when framed AND the switch is on", () => {
    expect(layout).toMatch(/const windowsEnabled = await isFloatingWindowsEnabled\(\)/)
    expect(layout).toMatch(/const embedded = isFramedNavigation\(headers\(\)\.get\('sec-fetch-dest'\)\) && windowsEnabled/)
  })

  it("mounts the window manager once, outside <main>, only when the switch is on, and never inside a window", () => {
    expect(layout).toMatch(/\{windowsEnabled && <ChromeOnly><WindowManager userId=\{user\.id\} sandbox=\{isSandbox\} \/><\/ChromeOnly>\}/)
    const main = layout.indexOf("</ShellMain>")
    expect(layout.indexOf("<WindowManager")).toBeGreaterThan(main)
  })

  it("offers 'open in a window' only on the main page, never inside a window", () => {
    expect(layout).toMatch(/<WindowsAvailableProvider available=\{windowsEnabled && !embedded\}>/)
  })

  it("no longer depends on the test-only environment flag", () => {
    expect(layout).not.toContain("WINDOW_SPIKE")
  })

  it("passes the decision into the freezing provider, around the whole shell", () => {
    expect(layout).toMatch(/<EmbeddedProvider initial=\{embedded\}>/)
    expect(layout).toMatch(/<\/ShellFrame>\s*<\/WindowsAvailableProvider>\s*<\/EmbeddedProvider>/)
  })

  it("only skips the chrome's data work when the page is in a window", () => {
    expect(layout).toMatch(/embedded\s*\?\s*\{ inbox: 0/)
    expect(layout).toMatch(/if \(!admin && !embedded\)/)
    expect(layout).toMatch(/embedded \? false : await isFloatingChatEnabled\(\)/)
  })
})

describe("embedded shell", () => {
  it("freezes the decision for the life of the page (a refresh must not flip it)", () => {
    expect(shell).toMatch(/const \[embedded\] = useState\(initial\)/)
  })

  it("ChromeOnly adds no markup of its own (the normal CRM renders exactly as before)", () => {
    expect(shell).toMatch(/return useEmbedded\(\) \? null : <>\{children\}<\/>/)
  })

  it("keeps the normal CRM's frame and main classes unchanged", () => {
    expect(shell).toContain("'flex h-[calc(100vh-2.5rem)] mt-10'")
    expect(shell).toContain("!embedded && 'pt-14 lg:pt-0'")
    expect(shell).toContain("'flex-1 overflow-y-auto overscroll-y-contain bg-zinc-50'")
  })

  it("the test bridge only listens to messages from the same site", () => {
    expect(shell).toMatch(/e\.origin !== window\.location\.origin/)
  })
})

describe("helper", () => {
  it("needs a real boolean true from the admin switch", () => {
    expect(helper).toMatch(/windowsEnabled === true && isFramedNavigation\(secFetchDest\)/)
  })
})

describe("history safety inside a window", () => {
  const backButton = readFileSync(join(root, "components/ui/back-button.tsx"), "utf8")
  const selection = readFileSync(join(root, "lib/hooks/use-selection-history.ts"), "utf8")
  const bridge = readFileSync(join(root, "lib/embed/window-bridge.ts"), "utf8")

  it("the shell installs the frame bridge only inside a window", () => {
    expect(shell).toMatch(/if \(!embedded\) return/)
    expect(shell).toMatch(/installWindowBridge\(window, \{ navigate: url => router\.push\(url\) \}\)/)
  })

  it("history.back() does nothing inside a window, and is restored afterwards", () => {
    expect(bridge).toMatch(/history\.back = \(\) => \{\}/)
    expect(bridge).toMatch(/history\.back = origBack/)
  })

  it("a navigation inside a window REPLACES the frame's history entry instead of adding one", () => {
    expect(bridge).toMatch(/history\.pushState = function \(\.\.\.args: HistoryArgs\) \{\s*const r = origReplace\.apply\(history, args\)/)
    expect(bridge).toMatch(/history\.pushState = origPush/)
  })

  it("the bridge only trusts messages from its own main page and own site", () => {
    expect(bridge).toMatch(/e\.source !== win\.parent \|\| e\.origin !== origin/)
  })

  it("the shared back arrow is not rendered inside a window (it would be dead)", () => {
    expect(backButton).toMatch(/if \(useEmbedded\(\)\) return null/)
  })

  it("selection changes replace the history entry inside a window instead of pushing one", () => {
    expect(selection).toMatch(/if \(embeddedRef\.current\) window\.history\.replaceState\(null, '', next\)/)
    expect(selection).toMatch(/else window\.history\.pushState\(null, '', next\)/)
  })
})
