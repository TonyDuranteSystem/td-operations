/**
 * Wiring guard for the floating-windows tour (dev job f3f3e237). The unit suite has no DOM, so these pin the
 * decisions the three reviews (UX designer, bug hunter, system counselor) hinged on — each one is a way the
 * tour could block the person, lose their windows, or leak.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const tour = read("components/windows/windows-tour.tsx")
const manager = read("components/windows/window-manager.tsx")
const launcher = read("components/dashboard/windows-launcher.tsx")
const navMenu = read("components/dashboard/nav-item-menu.tsx")
const waTour = read("components/inbox/whatsapp-tour.tsx")
const inbox = read("components/inbox/inbox-shell.tsx")

describe("the tour does not get in the person's way", () => {
  it("is a small card plus a ring — no dimming overlay library", () => {
    expect(tour).not.toMatch(/react-joyride/)
    expect(tour).toContain("pointer-events-none fixed z-[48]") // the ring never takes a click
    expect(tour).toContain("pointer-events-auto fixed bottom-24 z-[47]")
  })

  it("sits above the windows (44), the notes and the chat, but under the menus (70), so the launcher menu is never covered", () => {
    expect(tour).toContain("z-[47]")
    expect(tour).not.toMatch(/z-\[(5\d|6\d|7\d|10000)\]/)
  })

  it("is not a dialog (the floating chat's auto-pop looks for dialogs) and Escape does not end it", () => {
    expect(tour).not.toMatch(/role="dialog"/)
    expect(tour).toContain('role="region"')
    expect(tour).not.toMatch(/Escape/)
  })

  it("can be shrunk and moved to the other side so it never hides what the person is trying to do", () => {
    expect(tour).toContain("Shrink the card")
    expect(tour).toContain("Move the card to the other side")
  })

  it("respects reduced motion", () => {
    expect(tour).toContain("motion-safe:animate-pulse")
  })

  it("the ring hides once an action step is done, and the card warns when something covers the circled spot", () => {
    expect(tour).toContain("!(step.kind === 'act' && done)")
    expect(tour).toContain("document.elementFromPoint(")
    expect(tour).toContain("A window is covering the left menu")
  })

  it("the ring follows its target as it moves (a dragged window) and scrolls a far-away menu item into view", () => {
    expect(tour).toContain("requestAnimationFrame(tick)")
    expect(tour).toContain("scrollIntoView")
  })
})

describe("the tour never lies and never strands anyone", () => {
  it("a step with something to do waits for the manager's real events and is skippable", () => {
    expect(tour).toContain("onWindowEvent(ev => setProgress(p => applyWindowEvent(p, ev)))")
    expect(tour).toContain("Skip this step")
    expect(tour).not.toMatch(/I did it/)
  })

  it("Next is disabled for an action step until it is really done", () => {
    expect(tour).toMatch(/disabled=\{!done && step\.kind === 'act'\}/)
  })

  it("pauses on a narrow screen instead of skipping", () => {
    expect(tour).toContain("Make this window at least 1,000 pixels wide")
  })

  it("a plain click on a menu item gets a gentle nudge, not an error", () => {
    expect(tour).toContain("That opened the page here instead of in a window. No problem.")
  })

  it("resumes at the same step after a reload, and remembers it was seen", () => {
    expect(tour).toContain("sessionStorage")
    expect(tour).toContain("PROMPTED_PREFIX")
  })
})

describe("bug-hunt fixes on the built tour", () => {
  it("decides whether a step can run only after the window manager has published its windows (not on a stale empty list after a reload)", () => {
    expect(tour).toContain("!snapshot.ready")
    expect(tour).toContain("progress.stepIndex, snapshot.ready")
  })

  it("'auto' finishes only the steps where nothing-to-do is true", () => {
    expect(tour).toContain("AUTO_COMPLETES.includes(step.id)")
  })

  it("a note being typed survives moving between steps, and leaving with it unsent asks first", () => {
    expect(tour).toContain("value={draft}")
    expect(tour).toContain("You typed a note that has not been sent")
    expect(tour).toContain("const tryEnd = (finished: boolean)")
  })

  it("signing out ends the tour", () => {
    expect(tour).toContain("onAuthStateChange")
    expect(tour).toContain("event === 'SIGNED_OUT'")
  })

  it("the one-time prompt only shows in a tab the person can see, and is remembered only after it was shown", () => {
    expect(tour).toContain("document.visibilityState !== 'visible'")
    const shown = tour.indexOf("toast('New: floating windows'")
    const flag = tour.indexOf("setItem(key, 'shown')")
    expect(shown).toBeGreaterThan(-1)
    expect(flag).toBeGreaterThan(shown)
  })

  it("the card sits above the toast area, and a feedback request from the menu opens a shrunk card", () => {
    expect(tour).toContain("fixed bottom-24 z-[47]")
    expect(tour).toMatch(/onFeedback = \(\) => \{[\s\S]*setCollapsed\(false\)/)
  })

  it("the ring reports 'not covered' when its target changes or goes away", () => {
    expect(tour).toContain("onCovered(false) // a new target starts uncovered")
  })
})

describe("one tour at a time", () => {
  it("both tours use the shared lock", () => {
    expect(tour).toContain("acquireTour(LOCK)")
    expect(tour).toContain("releaseTour(LOCK)")
    expect(waTour).toContain("acquireTour('whatsapp')")
    expect(waTour).toContain("releaseTour('whatsapp')")
  })

  it("the WhatsApp tour no longer starts by itself inside a window frame, a pop-out, or on top of another tour", () => {
    expect(inbox).toContain("if (isFramedOrPopout() || isAnyTourActive()) return")
  })

  it("the one-time prompt waits, and only shows to someone who has no windows yet, is not typing, and has no update bar", () => {
    expect(tour).toContain("isAnyTourActive()")
    expect(tour).toContain("[data-update-banner]")
    expect(tour).toContain("snapshotRef.current.count > 0")
    expect(tour).toContain("typing")
    expect(tour).toContain("duration: Infinity")
    expect(tour).toContain("'Show me'")
    expect(tour).toContain("'Not now'")
  })
})

describe("mounting", () => {
  it("lives inside the window manager's gate (never in a frame or a pop-out, only when windows are on) with its OWN crash guard", () => {
    expect(manager).toMatch(/<WindowsCrashGuard>\s*<WindowsTour userId=\{userId\} \/>\s*<\/WindowsCrashGuard>/)
  })
})

describe("the window manager tells the tour what the person did", () => {
  it("reports opened, moved/resized (only a real drag), minimized, restored and closed with a reason", () => {
    expect(manager).toContain("emitWindowEvent({ type: 'opened'")
    expect(manager).toContain("classifyDrag(")
    expect(manager).toContain("emitWindowEvent({ type: 'minimized'")
    expect(manager).toContain("emitWindowEvent({ type: 'restored'")
    expect(manager).toContain("reason: action === 'popout' ? 'popout' : action === 'dock' ? 'docked' : 'closed'")
  })

  it("publishes which windows exist for the tour, and clears it when the manager goes away", () => {
    expect(manager).toContain("setWindowsSnapshot({")
    expect(manager).toContain("setWindowsSnapshot(EMPTY_SNAPSHOT)")
  })

  it("marks the parts the ring points at", () => {
    for (const part of ['data-win-id', 'data-win-part="titlebar"', 'part="minimize"', 'part="close"', 'data-win-part="tray-chip"']) {
      expect(manager, part).toContain(part)
    }
  })
})

describe("clearer words (UX review)", () => {
  it("the feature has one name in the menus: 'Open in a window'", () => {
    expect(navMenu).toContain("Open in a window")
    expect(navMenu).not.toContain("Open in floating window")
    expect(launcher).not.toContain("Opens as a floating window")
  })

  it("the button that replaces the main page is named for what it does, and the spelling is American", () => {
    expect(manager).toContain("Move to the main page (replaces the page behind)")
    expect(manager).not.toContain("Maximize2")
    expect(manager).toContain('label="Minimize"')
    expect(manager).not.toContain("Minimise")
    expect(manager).toContain("Click to bring this window back")
  })
})

describe("the launcher entries", () => {
  it("has the tour, the NEW tag, the feedback entry and the marker the ring points at", () => {
    expect(launcher).toContain("Take the 1-minute tour")
    expect(launcher).toContain("startWindowsTour()")
    expect(launcher).toContain(">NEW<")
    expect(launcher).toContain('data-tour="win-launcher"')
    expect(launcher).toContain("openWindowsFeedback()")
  })
})

describe("the tour never practises on pages that mark client messages read", () => {
  it("the only pages it opens or points at are Accounts and Leads", () => {
    expect(tour).toContain("requestOpenWindow('/accounts', 'Accounts')")
    expect(tour).not.toMatch(/requestOpenWindow\('\/(portal-chats|inbox)/)
  })
})
