import { describe, it, expect } from "vitest"
import {
  CHAT_SHARE_MAX_BYTES,
  CHAT_SHARE_MAX_MB,
  EMAIL_SHARE_MAX_BYTES,
  EMAIL_SHARE_MAX_MB,
  FAX_SHARE_MAX_BYTES,
  FAX_SHARE_MAX_MB,
  formatMb,
} from "@/lib/crm-storage/share-limits"

describe("share-limits constants", () => {
  it("CHAT_SHARE_MAX_BYTES matches its MB label", () => {
    expect(CHAT_SHARE_MAX_BYTES).toBe(CHAT_SHARE_MAX_MB * 1024 * 1024)
  })

  it("EMAIL_SHARE_MAX_BYTES matches its MB label", () => {
    expect(EMAIL_SHARE_MAX_BYTES).toBe(EMAIL_SHARE_MAX_MB * 1024 * 1024)
  })

  it("FAX_SHARE_MAX_BYTES matches its MB label", () => {
    expect(FAX_SHARE_MAX_BYTES).toBe(FAX_SHARE_MAX_MB * 1024 * 1024)
  })

  it("the fax ceiling stays safely under a base64-encoded platform body limit", () => {
    // Regression guard for the bug-hunter finding (2026-09-23): base64
    // inflates a raw file by ~1.37x, and this route has no server-side size
    // check of its own — if this constant crept back up near or above ~3.3MB
    // raw, an ordinary fax would fail with a raw platform error instead of
    // this app's own clear "too large" message.
    const base64Inflated = FAX_SHARE_MAX_BYTES * 1.37
    expect(base64Inflated).toBeLessThan(4.5 * 1024 * 1024)
  })
})

describe("formatMb", () => {
  it("formats exactly 1 MB", () => {
    expect(formatMb(1024 * 1024)).toBe("1.0")
  })

  it("formats a fractional MB to one decimal place", () => {
    expect(formatMb(1.5 * 1024 * 1024)).toBe("1.5")
  })

  it("formats zero bytes", () => {
    expect(formatMb(0)).toBe("0.0")
  })

  it("formats a large value (near the chat ceiling)", () => {
    expect(formatMb(CHAT_SHARE_MAX_BYTES)).toBe(CHAT_SHARE_MAX_MB.toFixed(1))
  })
})
