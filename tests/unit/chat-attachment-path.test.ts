import { describe, it, expect } from "vitest"
import { chatAttachmentDir, safeChatAttachmentExt, buildChatAttachmentPath } from "@/lib/portal/chat-attachment-path"

describe("chatAttachmentDir", () => {
  it("uses the account id when given", () => {
    expect(chatAttachmentDir("acct-1", "contact-1")).toBe("acct-1")
  })

  it("falls back to the contact id when there's no account", () => {
    expect(chatAttachmentDir(null, "contact-1")).toBe("contact-1")
  })

  it("falls back to 'unknown' when neither is given — matches the uploader route's own fallback", () => {
    expect(chatAttachmentDir(null, null)).toBe("unknown")
  })
})

describe("safeChatAttachmentExt", () => {
  it("lowercases a normal extension", () => {
    expect(safeChatAttachmentExt("Report.XLSX")).toBe("xlsx")
  })

  it("falls back to 'bin' for an extension outside the allow-list", () => {
    expect(safeChatAttachmentExt("script.exe")).toBe("bin")
  })

  it("falls back to 'bin' for a filename with no extension", () => {
    expect(safeChatAttachmentExt("noext")).toBe("bin")
  })

  it("strips anything that isn't alphanumeric before checking the allow-list — never trust a caller-supplied extension verbatim into a storage path", () => {
    expect(safeChatAttachmentExt("evil.pdf/../../secrets")).toBe("bin")
  })
})

describe("buildChatAttachmentPath", () => {
  it("produces the exact shape the uploader route and the attachment proxy both expect: chat-attachments/<dir>/<uuid>.<ext>", () => {
    const path = buildChatAttachmentPath("PnL 2025.xlsx", "acct-1", null)
    expect(path).toMatch(/^chat-attachments\/acct-1\/[0-9a-f-]{36}\.xlsx$/)
  })

  it("two calls for the same file never collide on the random segment", () => {
    const a = buildChatAttachmentPath("same.pdf", "acct-1", null)
    const b = buildChatAttachmentPath("same.pdf", "acct-1", null)
    expect(a).not.toBe(b)
  })
})
