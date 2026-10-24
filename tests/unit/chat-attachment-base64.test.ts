import { describe, it, expect } from "vitest"
import { decodeBase64Attachment, MAX_BASE64_ATTACHMENT_BYTES } from "@/lib/portal/chat-attachment-path"

describe("decodeBase64Attachment", () => {
  it("decodes plain base64", () => {
    const r = decodeBase64Attachment(Buffer.from("%PDF-1.4 hello").toString("base64"))
    expect("buffer" in r && r.buffer.toString()).toBe("%PDF-1.4 hello")
  })
  it("decodes a data: URI and ignores whitespace", () => {
    const b64 = Buffer.from("abc123").toString("base64")
    const r = decodeBase64Attachment(`data:application/pdf;base64,\n${b64.slice(0, 4)} ${b64.slice(4)}`)
    expect("buffer" in r && r.buffer.toString()).toBe("abc123")
  })
  it("rejects empty and invalid input", () => {
    expect("error" in decodeBase64Attachment("")).toBe(true)
    expect("error" in decodeBase64Attachment("not base64!!")).toBe(true)
  })
  it("rejects files over the cap", () => {
    const big = Buffer.alloc(MAX_BASE64_ATTACHMENT_BYTES + 1, 1).toString("base64")
    expect("error" in decodeBase64Attachment(big)).toBe(true)
  })
})
