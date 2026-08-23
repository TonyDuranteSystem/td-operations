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
  // Deliberately NOT an allow-list (see the function's own doc comment) —
  // dangerous file TYPES are rejected separately by validateChatAttachment()
  // before this ever runs. This function only sanitizes the storage KEY.

  it("lowercases a normal extension", () => {
    expect(safeChatAttachmentExt("Report.XLSX")).toBe("xlsx")
  })

  it("preserves a real extension outside any narrow allow-list — e.g. a phone photo's .heic must survive so the chat UI still renders it inline", () => {
    expect(safeChatAttachmentExt("passport-photo.HEIC")).toBe("heic")
  })

  it("a filename with no dot at all becomes its own (sanitized) pseudo-extension — matches the uploader route's exact behavior, not a regression introduced here", () => {
    expect(safeChatAttachmentExt("noext")).toBe("noext")
  })

  it("falls back to 'bin' when there IS a dot but nothing usable survives after it", () => {
    expect(safeChatAttachmentExt("file.")).toBe("bin")
    expect(safeChatAttachmentExt("file.***")).toBe("bin")
  })

  it("strips anything that isn't alphanumeric — a path-traversal payload can never survive into the storage key, even though nothing here is a path allow-list", () => {
    const result = safeChatAttachmentExt("evil.pdf/../../secrets")
    expect(result).not.toContain("/")
    expect(result).not.toContain("..")
    expect(result).toMatch(/^[a-z0-9]*$/)
  })

  it("caps length at 8 characters — matches the uploader route's own cap, so an unusually long trailing segment can't bloat the storage key", () => {
    expect(safeChatAttachmentExt("file.reallylongextension")).toBe("reallylo")
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
