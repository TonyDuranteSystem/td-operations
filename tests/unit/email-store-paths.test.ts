import { describe, it, expect } from "vitest"
import {
  bodyStoragePath,
  safeContentType,
  attachmentStoragePath,
  captureStatus,
  assertMailbox,
} from "@/lib/email-store/paths"

describe("email-store storage paths", () => {
  it("builds a body path under the mailbox/message prefix", () => {
    expect(bodyStoragePath("support", "18f2ab9c")).toBe("support/18f2ab9c/body.html")
  })

  it("attachment path never contains the sender filename and is stable per id", () => {
    const p = attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0001")
    expect(p.startsWith("support/18f2ab9c/att/")).toBe(true)
    // opaque 32-hex, no filename leaked
    expect(p).toMatch(/^support\/18f2ab9c\/att\/[0-9a-f]{32}$/)
    // deterministic
    expect(attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0001")).toBe(p)
    // different attachment id → different path
    expect(attachmentStoragePath("support", "18f2ab9c", "ANGjdJ_att-0002")).not.toBe(p)
  })

  it("rejects a hostile message_id (path traversal fail-closed)", () => {
    expect(() => bodyStoragePath("support", "../../signed-contracts")).toThrow()
    expect(() => attachmentStoragePath("support", "a/../b", "att1")).toThrow()
  })

  it("rejects an unknown mailbox", () => {
    expect(() => bodyStoragePath("marketing", "abc")).toThrow()
    expect(() => assertMailbox("client")).toThrow()
  })

  it("rejects an empty attachment id", () => {
    expect(() => attachmentStoragePath("support", "abc", "")).toThrow()
  })
})

describe("email-store capture completeness", () => {
  it("is complete only when raw stored AND all attachments stored", () => {
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 0, attachmentsStored: 0 })).toBe("complete")
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 3, attachmentsStored: 3 })).toBe("complete")
  })

  it("is pending when the body is missing", () => {
    expect(captureStatus({ bodyStored: false, attachmentsExpected: 0, attachmentsStored: 0 })).toBe("pending")
  })

  it("is pending when any attachment is missing (partial write not trusted)", () => {
    expect(captureStatus({ bodyStored: true, attachmentsExpected: 5, attachmentsStored: 2 })).toBe("pending")
  })

  it("throws on negative counts", () => {
    expect(() => captureStatus({ bodyStored: true, attachmentsExpected: -1, attachmentsStored: 0 })).toThrow()
  })
})

describe("safeContentType", () => {
  it("passes a clean type through, lowercased", () => {
    expect(safeContentType("application/pdf")).toBe("application/pdf")
    expect(safeContentType("Image/PNG")).toBe("image/png")
  })

  it("strips parameters that made Storage reject the upload", () => {
    // the real-world shape behind the 218 failed messages
    expect(safeContentType('application/pdf; name="Invoice 2025.pdf"')).toBe("application/pdf")
    expect(safeContentType("text/html; charset=UTF-8")).toBe("text/html")
  })

  it("falls back for junk instead of failing the whole email", () => {
    for (const junk of ["", "   ", "not-a-mime", "application/", "/pdf", "app lication/pdf", "application\\pdf"]) {
      expect(safeContentType(junk)).toBe("application/octet-stream")
    }
  })

  it("falls back for null/undefined/non-strings", () => {
    expect(safeContentType(null)).toBe("application/octet-stream")
    expect(safeContentType(undefined)).toBe("application/octet-stream")
    // @ts-expect-error deliberately wrong type
    expect(safeContentType(42)).toBe("application/octet-stream")
  })

  it("keeps valid token punctuation (vendor + suffix types)", () => {
    expect(safeContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(safeContentType("image/svg+xml")).toBe("image/svg+xml")
  })
})
