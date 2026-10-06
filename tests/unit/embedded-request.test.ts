/**
 * Floating-window frame helpers (dev job f3f3e237).
 */

import { describe, it, expect } from "vitest"
import { isEmbeddedRequest, isFramedNavigation } from "@/lib/embed/embedded-request"

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
