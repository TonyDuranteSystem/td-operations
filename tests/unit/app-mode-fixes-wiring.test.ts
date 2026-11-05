/**
 * Wiring guard for the six fixes after the bug-hunter pass on the TD Social app screens (dev job 2072bc3e, Step 1b, 4 Nov 2026).
 *
 * The unit suite runs in node (no DOM), so each fix is pinned by what the source must say. Every one of these was a way a phone
 * user got stuck, lost a safety notice, or found the size rules missing:
 *  1. Marketing "Viewing as" notice + its way out stay in the app
 *  2. a shrunk email must not leave a blank scrolling band in its frame
 *  3. Portal chats must not leave a dead strip under it in the app
 *  4. Marketing Chat on a phone follows the chat that really exists (never neither screen)
 *  5. the app marker also reaches the page root (pop-ups, the Reply window, menus) and the lead page's own window
 *  6. small accessibility items (alert role off a button, Escape closes the sheets)
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

const marketingApp = read("app/marketing/(app)/layout.tsx")
const marketingRoot = read("app/marketing/layout.tsx")
const chatWorkspace = read("components/marketing/chat-workspace.tsx")
const emailFrame = read("components/inbox/email-html-frame.tsx")
const portalChats = read("app/(dashboard)/portal-chats/page.tsx")
const provider = read("components/app-mode/app-mode-provider.tsx")
const banner = read("components/inbox/whatsapp-bridge-banner.tsx")
const threadActions = read("components/inbox/app-thread-actions.tsx")
const inboxShell = read("components/inbox/inbox-shell.tsx")
const css = read("app/globals.css")

describe("fix 1: the Marketing app keeps the 'Viewing as' notice", () => {
  // the app branch is the part of the layout between `if (getAppMode()) {` and the computer layout's own return
  const start = marketingApp.indexOf("if (getAppMode()) {")
  const end = marketingApp.indexOf("<MessageVoice", start)
  const appBranch = marketingApp.slice(start, end)

  it("finds the app branch", () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  it("shows who Antonio is viewing as, with the way out, ABOVE the page", () => {
    expect(appBranch).toMatch(/\{ctx\.viewAs && \(/)
    expect(appBranch).toContain('data-testid="app-view-as"')
    expect(appBranch).toContain("<ExitViewButton />")
    expect(appBranch.indexOf("app-view-as")).toBeLessThan(appBranch.indexOf("<LeadWindowsHost"))
  })

  it("uses an existing, already-translated label (no new untranslated string)", () => {
    expect(appBranch).toContain("t('Viewing as')")
  })
})

describe("fix 2: a shrunk email does not scroll through a blank band", () => {
  it("clips the frame's own vertical scroll when the email is shrunk, and gives it back otherwise", () => {
    expect(emailFrame).toContain("doc.documentElement.style.overflowY = ''")
    const shrunk = emailFrame.slice(emailFrame.indexOf("if (k < 1) {"), emailFrame.indexOf("return\n      }"))
    expect(shrunk).toContain("doc.documentElement.style.overflowY = 'hidden'")
    // ...and it is set before the frame is resized (the resize reads the shrunk height)
    expect(shrunk.indexOf("overflowY = 'hidden'")).toBeLessThan(shrunk.indexOf("setHeight("))
  })
})

describe("fix 3: Portal chats takes the whole height in the app", () => {
  it("marks the page root app-fill and the app CSS gives it the full height", () => {
    expect(portalChats).toContain('className="app-fill flex h-[calc(100vh-4rem)] overflow-hidden"')
    expect(css).toContain('[data-app-mode="true"] .app-fill { height: 100%; }')
  })

  it("keeps the normal CRM's own sizing class on that root (nothing replaced)", () => {
    expect(portalChats).toMatch(/app-fill flex h-\[calc\(100vh-4rem\)\]/)
  })
})

describe("fix 4: Marketing Chat on a phone never shows neither screen", () => {
  it("hides the list and shows the pane by the chat that EXISTS (`current`), not by the id asked for (`sel`)", () => {
    expect(chatWorkspace).toMatch(/\$\{current \? 'hidden md:block' : 'block'\}/)
    expect(chatWorkspace).toMatch(/\$\{current \? 'flex' : 'hidden md:flex'\}/)
    expect(chatWorkspace).not.toMatch(/\$\{sel \? '/)
  })

  it("keeps the back arrow inside the open chat (the only place it can appear)", () => {
    const pane = chatWorkspace.slice(chatWorkspace.indexOf("{current ? ("), chatWorkspace.indexOf("Pick a chat on the left"))
    expect(pane).toContain('data-testid="chat-back"')
  })
})

describe("fix 5: the app marker reaches the page root and the lead page", () => {
  it("puts the marker on the page's root element when the page is awake, and takes it off when the layout goes", () => {
    expect(provider).toMatch(/if \(!appMode\) return/)
    expect(provider).toContain("root.setAttribute('data-app-mode', 'true')")
    expect(provider).toContain("return () => root.removeAttribute('data-app-mode')")
  })

  it("wraps ALL Marketing pages (including the lead page window) in app mode, and a normal browser gets no wrapper at all", () => {
    expect(marketingRoot).toContain("{appMode ? <AppModeProvider initial>{children}</AppModeProvider> : children}")
  })

  it("leaves the (app) layout without its own second provider (two would fight over the root marker)", () => {
    expect(marketingApp).not.toContain("AppModeProvider")
  })
})

describe("fix 6: small accessibility items", () => {
  it("keeps the alert role off the folded WhatsApp button (a wrapper carries it)", () => {
    expect(banner).toContain('<div role="alert">')
    expect(banner).not.toMatch(/role="alert" data-testid="wa-bridge-banner-folded"/)
  })

  it("closes the '…' menu and the Folders sheet with Escape; the sheet is a labelled dialog", () => {
    expect(threadActions).toContain("e.key === 'Escape'")
    expect(inboxShell).toContain("if (e.key === 'Escape') setFolderSheetOpen(false)")
    expect(inboxShell).toContain('role="dialog" aria-modal="true" aria-label="Folders" data-testid="app-folder-sheet"')
  })
})
