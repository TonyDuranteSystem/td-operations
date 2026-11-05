/**
 * The TD Social app's CSS must never leak into the normal CRM (dev job 2072bc3e, Step 1b; the bug-hunter pass of 4 Nov 2026).
 *
 * Every app-only rule in app/globals.css has to start with [data-app-mode="true"], and the helper classes (app-hide, app-tabs-scroll,
 * app-conv-header, app-compact-taps, app-fill) must do nothing without it. A single unscoped rule would change the computer CRM for
 * every staff member, so this reads the real stylesheet and checks every selector, instead of trusting that "it is scoped today".
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const raw = readFileSync(join(__dirname, "..", "..", "app/globals.css"), "utf8")
const MARKER = '[data-app-mode="true"]'
const HELPERS = [".app-hide", ".app-tabs-scroll", ".app-conv-header", ".app-compact-taps", ".app-fill"]

/** every selector of every rule, comments stripped (the file has no commas inside parentheses, so a plain split is safe) */
function selectors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: string[] = []
  const rule = /([^{}]+)\{[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = rule.exec(noComments)) !== null) {
    for (const s of m[1].split(",")) {
      const sel = s.trim()
      if (sel && !sel.startsWith("@")) out.push(sel)
    }
  }
  return out
}

const all = selectors(raw)
const appOnly = all.filter(s => s.includes("data-app-mode") || HELPERS.some(h => s.includes(h)))

describe("app mode CSS: scoped to the app marker", () => {
  it("finds the app rules (the check is not silently reading nothing)", () => {
    expect(appOnly.length).toBeGreaterThanOrEqual(12)
  })

  it("starts EVERY app rule with the marker, so none can match in a normal browser", () => {
    const unscoped = appOnly.filter(s => !s.startsWith(MARKER))
    expect(unscoped).toEqual([])
  })

  it("never uses a helper class in a rule that lacks the marker", () => {
    for (const h of HELPERS) {
      const bare = all.filter(s => s.includes(h) && !s.startsWith(MARKER))
      expect(bare, h).toEqual([])
    }
  })

  it("has a rule for each helper class (so removing one is noticed)", () => {
    for (const h of HELPERS) {
      expect(all.some(s => s.startsWith(MARKER) && s.includes(h)), h).toBe(true)
    }
  })
})
