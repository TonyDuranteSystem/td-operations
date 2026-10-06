/**
 * Left-menu ⋯ menu helpers (dev job f3f3e237, step 1).
 */

import { describe, it, expect } from "vitest"
import { isInternalNavHref, absoluteNavUrl } from "@/lib/nav/nav-link"

describe("isInternalNavHref", () => {
  it("accepts normal CRM page paths", () => {
    expect(isInternalNavHref("/")).toBe(true)
    expect(isInternalNavHref("/inbox")).toBe(true)
    expect(isInternalNavHref("/clients/audit")).toBe(true)
    expect(isInternalNavHref("/dashboard/td-communication")).toBe(true)
    expect(isInternalNavHref("/portal-chats?account=abc&message=1")).toBe(true)
  })

  it("rejects outside, scheme and protocol-relative addresses", () => {
    expect(isInternalNavHref("https://evil.com/x")).toBe(false)
    expect(isInternalNavHref("//evil.com/x")).toBe(false)
    expect(isInternalNavHref("javascript:alert(1)")).toBe(false)
    expect(isInternalNavHref("data:text/html,hi")).toBe(false)
    expect(isInternalNavHref("inbox")).toBe(false)
    expect(isInternalNavHref("./inbox")).toBe(false)
  })

  it("rejects backslash tricks and control characters", () => {
    expect(isInternalNavHref("/\\evil.com")).toBe(false)
    expect(isInternalNavHref("/in\nbox")).toBe(false)
    expect(isInternalNavHref("/in\u0000box")).toBe(false)
    expect(isInternalNavHref("/in\tbox")).toBe(false)
  })

  it("rejects empty and non-string values", () => {
    expect(isInternalNavHref("")).toBe(false)
    expect(isInternalNavHref(undefined)).toBe(false)
    expect(isInternalNavHref(null)).toBe(false)
    expect(isInternalNavHref(42)).toBe(false)
  })
})

describe("absoluteNavUrl", () => {
  it("joins origin and path", () => {
    expect(absoluteNavUrl("https://crm.tonydurante.us", "/inbox")).toBe("https://crm.tonydurante.us/inbox")
    expect(absoluteNavUrl("http://localhost:3000", "/")).toBe("http://localhost:3000/")
  })

  it("does not double the slash when the origin ends with one", () => {
    expect(absoluteNavUrl("https://crm.tonydurante.us/", "/leads")).toBe("https://crm.tonydurante.us/leads")
    expect(absoluteNavUrl("https://crm.tonydurante.us///", "/leads")).toBe("https://crm.tonydurante.us/leads")
  })

  it("keeps the query string of the path", () => {
    expect(absoluteNavUrl("https://x.us", "/portal-chats?account=1")).toBe("https://x.us/portal-chats?account=1")
  })

  it("returns null for a bad path", () => {
    expect(absoluteNavUrl("https://x.us", "//evil.com")).toBeNull()
    expect(absoluteNavUrl("https://x.us", "javascript:alert(1)")).toBeNull()
    expect(absoluteNavUrl("https://x.us", "")).toBeNull()
  })

  it("returns null when there is no usable origin", () => {
    expect(absoluteNavUrl(undefined, "/inbox")).toBeNull()
    expect(absoluteNavUrl(null, "/inbox")).toBeNull()
    expect(absoluteNavUrl("", "/inbox")).toBeNull()
    expect(absoluteNavUrl("not a url", "/inbox")).toBeNull()
    expect(absoluteNavUrl("javascript:alert(1)", "/inbox")).toBeNull()
  })
})
