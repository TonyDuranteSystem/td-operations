import { describe, it, expect } from "vitest"
import { createHash } from "crypto"
import { gmailAttachmentCallerKey } from "@/lib/crm-store/gmail-attachment-key"

describe("gmailAttachmentCallerKey", () => {
  const bytes = Buffer.from("same attachment bytes")
  it("is the message id + the SHA-256 of the bytes + the lower-cased name", () => {
    const sha = createHash("sha256").update(bytes).digest("hex")
    expect(gmailAttachmentCallerKey("msg1", bytes, "Invoice.PDF")).toBe(`gmail-attachment:msg1:${sha}:invoice.pdf`)
  })
  it("does not depend on the Gmail attachment id (not stable between calls): a repeat save has the same key", () => {
    expect(gmailAttachmentCallerKey("msg1", Buffer.from(bytes), "a.pdf")).toBe(gmailAttachmentCallerKey("msg1", Buffer.from(bytes), "a.pdf"))
  })
  it("different bytes, message or name give a different key", () => {
    const k = gmailAttachmentCallerKey("msg1", bytes, "a.pdf")
    expect(gmailAttachmentCallerKey("msg1", Buffer.from("other"), "a.pdf")).not.toBe(k)
    expect(gmailAttachmentCallerKey("msg2", bytes, "a.pdf")).not.toBe(k)
    expect(gmailAttachmentCallerKey("msg1", bytes, "b.pdf")).not.toBe(k)
  })
})
