/**
 * Floating-window frame test helpers (dev job f3f3e237, step 3).
 */

import { describe, it, expect } from "vitest"
import { isEmbeddedRequest, isFramedNavigation } from "@/lib/embed/embedded-request"
import { evaluateFrame, summarize, isLoginPath, type FrameSnapshot } from "@/lib/embed/spike-evaluate"

describe("isFramedNavigation", () => {
  it("is true only for a page load made by a frame", () => {
    expect(isFramedNavigation("iframe")).toBe(true)
    expect(isFramedNavigation(" IFRAME ")).toBe(true)
  })

  it("is false for normal page loads, refreshes and missing labels", () => {
    expect(isFramedNavigation("document")).toBe(false)
    expect(isFramedNavigation("empty")).toBe(false)
    expect(isFramedNavigation("frame")).toBe(false)
    expect(isFramedNavigation(null)).toBe(false)
    expect(isFramedNavigation(undefined)).toBe(false)
    expect(isFramedNavigation("")).toBe(false)
  })
})

describe("isEmbeddedRequest", () => {
  it("is true only for a framed load while the admin switch is on", () => {
    expect(isEmbeddedRequest("iframe", true)).toBe(true)
  })

  it("is false whenever the switch is off, whatever the browser says", () => {
    expect(isEmbeddedRequest("iframe", false)).toBe(false)
  })

  it("is false for anything that is not a framed load, even with the switch on", () => {
    expect(isEmbeddedRequest("document", true)).toBe(false)
    expect(isEmbeddedRequest("empty", true)).toBe(false)
    expect(isEmbeddedRequest(null, true)).toBe(false)
    expect(isEmbeddedRequest(undefined, true)).toBe(false)
  })

  it("never treats a non-boolean as 'on' (only a real true enables it)", () => {
    expect(isEmbeddedRequest("iframe", "1" as unknown as boolean)).toBe(false)
    expect(isEmbeddedRequest("iframe", 1 as unknown as boolean)).toBe(false)
  })
})

const good: FrameSnapshot = {
  src: "/inbox",
  pathname: "/inbox",
  embeddedAttr: "true",
  hasSidebar: false,
  hasMain: true,
  alertPolls: 0,
}

describe("evaluateFrame", () => {
  it("passes a bare, quiet, loaded frame", () => {
    const v = evaluateFrame(good)
    expect(v.pass).toBe(true)
    expect(v.checks.every(c => c.pass)).toBe(true)
  })

  it("fails when the frame shows the sign-in page", () => {
    const v = evaluateFrame({ ...good, pathname: "/login", hasMain: false })
    expect(v.pass).toBe(false)
    expect(v.checks.find(c => c.id === "loaded")!.detail).toMatch(/sign-in/)
    const mfa = evaluateFrame({ ...good, pathname: "/mfa/verify" })
    expect(mfa.checks.find(c => c.id === "loaded")!.pass).toBe(false)
  })

  it("fails when the page loaded as the full CRM (marker missing or off)", () => {
    expect(evaluateFrame({ ...good, embeddedAttr: null, hasSidebar: true }).checks.find(c => c.id === "bare")!.pass).toBe(false)
    expect(evaluateFrame({ ...good, embeddedAttr: "false" }).checks.find(c => c.id === "bare")!.pass).toBe(false)
  })

  it("fails when the marker is on but a left menu is still present", () => {
    const c = evaluateFrame({ ...good, hasSidebar: true }).checks.find(x => x.id === "bare")!
    expect(c.pass).toBe(false)
    expect(c.detail).toMatch(/left menu is still there/)
  })

  it("fails when the frame polls for alerts", () => {
    const v = evaluateFrame({ ...good, alertPolls: 2 })
    expect(v.pass).toBe(false)
    expect(v.checks.find(c => c.id === "quiet")!.detail).toMatch(/2 alert request/)
  })

  it("fails everything when the frame could not be read", () => {
    const v = evaluateFrame({ ...good, error: "blocked" })
    expect(v.pass).toBe(false)
    expect(v.checks.every(c => !c.pass)).toBe(true)
  })

  it("does not call a not-yet-rendered page loaded", () => {
    const v = evaluateFrame({ ...good, hasMain: false })
    expect(v.checks.find(c => c.id === "loaded")!.pass).toBe(false)
  })
})

describe("isLoginPath", () => {
  it("recognises sign-in and verification pages", () => {
    expect(isLoginPath("/login")).toBe(true)
    expect(isLoginPath("/mfa")).toBe(true)
    expect(isLoginPath("/mfa/verify")).toBe(true)
    expect(isLoginPath("/loginx")).toBe(false)
    expect(isLoginPath("/inbox")).toBe(false)
  })
})

describe("summarize", () => {
  it("says PASS only when every frame passes", () => {
    const ok = evaluateFrame(good)
    const bad = evaluateFrame({ ...good, src: "/tasks", alertPolls: 1 })
    expect(summarize([ok, ok]).pass).toBe(true)
    const s = summarize([ok, bad])
    expect(s.pass).toBe(false)
    expect(s.text).toMatch(/1 of 2/)
    expect(s.text).toMatch(/\/tasks/)
  })

  it("never passes an empty set", () => {
    expect(summarize([]).pass).toBe(false)
  })
})
