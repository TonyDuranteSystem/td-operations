/**
 * Wiring guard for app mode (TD Social phone app, dev job 2072bc3e, Step 1b).
 *
 * The shells have no DOM test (the unit suite runs in node), so these checks pin the decisions the review hinged on.
 * Each is a way the whole CRM could break for everyone — or a window could break — if someone "tidies" the layouts:
 *  - app mode is a LAYOUT hint read from the browser name; the login check always runs first and is never conditional;
 *  - app mode is NOT a frame: the window bridge and the window manager stay frame-only;
 *  - the normal browser sees no change (the app wrapper adds no box; the app-only CSS needs the marker);
 *  - the app is light only in its first release.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

const layout = read("app/(dashboard)/layout.tsx")
const shell = read("components/dashboard/embedded-shell.tsx")
const provider = read("components/app-mode/app-mode-provider.tsx")
const server = read("lib/app-mode/server.ts")
const css = read("app/globals.css")
const incident = read("components/infra/supabase-incident-bar.tsx")

describe("app mode: dashboard layout", () => {
  it("decides app mode from the browser name, after the login check, and wraps everything in the provider", () => {
    expect(layout.indexOf("if (!user) {")).toBeGreaterThan(-1)
    expect(layout.indexOf("const appMode = getAppMode()")).toBeGreaterThan(layout.indexOf("if (!user) {"))
    expect(layout).toMatch(/<Providers>\s*<AppModeProvider initial=\{appMode\}>/)
    expect(layout).toMatch(/<\/EmbeddedProvider>\s*<\/AppModeProvider>\s*<\/Providers>/)
  })

  it("keeps the frame-only parts frame-only: app mode is not a window", () => {
    expect(layout).toMatch(/const embedded = framed && windowsEnabled/)
    expect(layout).toMatch(/<EmbeddedProvider initial=\{embedded\}>/)
    expect(layout).toMatch(/<WindowsAvailableProvider available=\{windowsEnabled && !embedded\}>/)
    // the window bridge is installed only when the page is a window
    expect(shell).toMatch(/if \(!embedded\) return/)
  })

  it("keeps the Supabase notice in the app (hidden only inside a window)", () => {
    expect(layout).toMatch(/<HiddenInWindows><SupabaseIncidentBar audience="staff" \/><\/HiddenInWindows>/)
  })

  it("is light only inside the app: neither the dark-mode script nor its sync runs", () => {
    expect(layout).toMatch(/\{!appMode && <ThemeScript \/>\}/)
    expect(layout).toMatch(/\{!appMode && <ThemeSync \/>\}/)
  })
})

describe("app mode: shell", () => {
  it("hides the chrome in the app and drops the phone top-bar spacing and the sandbox offset", () => {
    expect(shell).toMatch(/return embedded \|\| appMode \? null/)
    expect(shell).toMatch(/const bare = embedded \|\| appMode/)
    expect(shell).toMatch(/className=\{bare \? 'flex h-screen'/)
  })
})

describe("app mode: the page keeps its message box on screen", () => {
  it("wraps the page in <ShellBody> (no box outside the app) and makes the main area a column only in the app", () => {
    expect(layout).toMatch(/<ShellBody>\{children\}<\/ShellBody>/)
    expect(shell).toMatch(/export function ShellBody/)
    expect(shell).toMatch(/useAppMode\(\) \? <div className="min-h-0 flex-1 overflow-y-auto">\{children\}<\/div> : <>\{children\}<\/>/)
    expect(shell).toMatch(/appMode && 'flex flex-col'/)
  })
})

describe("app mode: provider and CSS", () => {
  it("is a display:contents wrapper (adds no box) that carries the marker only inside the app", () => {
    expect(provider).toMatch(/data-app-mode=\{appMode \? 'true' : undefined\}/)
    expect(provider).toMatch(/className="contents"/)
    expect(provider).toMatch(/const \[appMode\] = useState\(initial\)/)
  })

  it("reads the browser name on the server only", () => {
    expect(server).toMatch(/headers\(\)\.get\('user-agent'\)/)
  })

  it("hides `app-hide` parts only when the marker is on", () => {
    expect(css).toMatch(/\[data-app-mode="true"\] \.app-hide \{ display: none !important; \}/)
  })
})

describe("app mode: Supabase notice", () => {
  it("takes one line in the app (tap to read it all) and keeps the normal bar everywhere else", () => {
    expect(incident).toMatch(/if \(appMode\) \{/)
    expect(incident).toMatch(/truncate/)
    expect(incident).toMatch(/className="sticky top-0 z-\[95\] flex w-full items-start gap-2 bg-red-600 px-4 py-2 text-sm text-white shadow"/)
  })
})
