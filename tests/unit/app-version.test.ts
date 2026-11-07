/**
 * TD Social phone app — what the app's version tells the web screens, and the initials rule shared with the app (dev job 2072bc3e, 5 Nov 2026).
 * The round "You" button inside the list screens must appear ONLY on app builds that can open the "You" screen (0.2.0+); an older build still draws
 * its own top strip, so a second button there would be a duplicate with nothing behind it.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { appHasYouBridge, appVersionFromUserAgent, initialsOf } from "@/lib/app-mode/app-version"

const UA = (v: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TDSocial/${v}`

describe("appVersionFromUserAgent", () => {
  it("reads the version out of the browser name", () => {
    expect(appVersionFromUserAgent(UA("0.2.0"))).toEqual([0, 2, 0])
    expect(appVersionFromUserAgent(UA("1.10.3"))).toEqual([1, 10, 3])
  })
  it("reads a two-part version as the same version with a third number of 0 (the App Store's first version may be written 1.0)", () => {
    expect(appVersionFromUserAgent(UA("1.0"))).toEqual([1, 0, 0])
    expect(appVersionFromUserAgent(UA("1.0.0"))).toEqual([1, 0, 0])
    expect(appVersionFromUserAgent(UA("0.2"))).toEqual([0, 2, 0])
    expect(appHasYouBridge(UA("1.0"))).toBe(true) // version 1.0 must never lose the round "You" button
    expect(appHasYouBridge(UA("1.0.0"))).toBe(true)
  })
  it("is null for a normal browser, an empty value or a malformed token", () => {
    expect(appVersionFromUserAgent("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBeNull()
    expect(appVersionFromUserAgent("")).toBeNull()
    expect(appVersionFromUserAgent(null)).toBeNull()
    expect(appVersionFromUserAgent(undefined)).toBeNull()
    expect(appVersionFromUserAgent("TDSocial/x.y.z")).toBeNull()
  })
})

describe("appHasYouBridge", () => {
  it("is false for the first two builds (0.1.0, 0.1.1) and for a browser", () => {
    expect(appHasYouBridge(UA("0.1.0"))).toBe(false)
    expect(appHasYouBridge(UA("0.1.1"))).toBe(false)
    expect(appHasYouBridge("Mozilla/5.0 Safari")).toBe(false)
  })
  it("is true from 0.2.0 on, including a later major version", () => {
    expect(appHasYouBridge(UA("0.2.0"))).toBe(true)
    expect(appHasYouBridge(UA("0.10.0"))).toBe(true)
    expect(appHasYouBridge(UA("1.0.0"))).toBe(true)
  })
})

describe("initialsOf (same rule as the app's Initials.of)", () => {
  it("matches the app's own test cases", () => {
    expect(initialsOf("Antonio Durante", null)).toBe("AD")
    expect(initialsOf("Luca", "luca@x.us")).toBe("L")
    expect(initialsOf("Maria Elena Rossi", null)).toBe("ME")
    expect(initialsOf("  ", "jodi@tonydurante.us")).toBe("J")
    expect(initialsOf("", null)).toBe("?")
    expect(initialsOf(undefined, undefined)).toBe("?")
  })
  it("keeps a whole letter of an accented or emoji name", () => {
    expect(initialsOf("Élodie Martin", null)).toBe("ÉM")
  })
})

describe("the round button is only ever placed inside the app's own list screens", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8")
  it("the button renders nothing without the bridge (so a normal browser and an old build show no extra control)", () => {
    const src = read("components/app-mode/app-you-button.tsx")
    expect(src).toContain("if (!has) return null")
    expect(src).toContain("appHasYouBridge(navigator.userAgent)")
    expect(src).toContain("if (appMode && ")
  })
  it("the Inbox / WhatsApp title bar shows only on a list (never on an open email) and only in the app", () => {
    expect(read("components/inbox/inbox-shell.tsx")).toContain("{appMode && !selected && <AppListTitle")
  })
  it("the web page talks to the app through ONE message name", () => {
    expect(read("components/app-mode/app-you-button.tsx")).toContain("messageHandlers?.tdsocial?.postMessage('you')")
  })
})
